#!/usr/bin/env python3
"""Set or clear a Flagsmith Edge identity override for checkout_a11y.

Reads FLAGSMITH_ADMIN_API_TOKEN, FLAGSMITH_ENVIRONMENT_KEY, and
FLAGSMITH_FEATURE_ID from the environment. Used by
scripts/record-phase-a.mjs so clip 01 can start on the control arm.
"""
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

TOKEN = os.environ.get("FLAGSMITH_ADMIN_API_TOKEN", "")
ENV = os.environ.get("FLAGSMITH_ENVIRONMENT_KEY", "")
FEATURE_RAW = os.environ.get("FLAGSMITH_FEATURE_ID", "")
ADMIN = {
    "Authorization": f"Api-Key {TOKEN}",
    "Accept": "application/json",
    "Content-Type": "application/json",
}


def req(url, method="GET", body=None, headers=None):
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(url, data=data, method=method, headers=headers or ADMIN)
    try:
        with urllib.request.urlopen(request, timeout=20) as resp:
            raw = resp.read().decode()
            try:
                return resp.status, json.loads(raw) if raw else None
            except json.JSONDecodeError:
                return resp.status, raw
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode()[:800]


def edge_uuid(identifier):
    q = urllib.parse.quote(identifier)
    status, data = req(
        f"https://api.flagsmith.com/api/v1/environments/{ENV}/edge-identities/?q={q}"
    )
    if status != 200:
        raise SystemExit(f"edge-identities {status} {data}")
    rows = data.get("results") or []
    if not rows:
        urllib.request.urlopen(
            urllib.request.Request(
                f"https://edge.api.flagsmith.com/api/v1/identities/?identifier={q}",
                headers={"X-Environment-Key": ENV},
            ),
            timeout=15,
        ).read()
        status, data = req(
            f"https://api.flagsmith.com/api/v1/environments/{ENV}/edge-identities/?q={q}"
        )
        rows = (data or {}).get("results") or []
    if not rows:
        raise SystemExit(f"no edge identity for {identifier}")
    return rows[0]["identity_uuid"]


def list_states(uuid):
    status, data = req(
        f"https://api.flagsmith.com/api/v1/environments/{ENV}/edge-identities/{uuid}/edge-featurestates/"
    )
    if status != 200:
        raise SystemExit(f"list states {status} {data}")
    return data or []


def set_control(identifier):
    uuid = edge_uuid(identifier)
    existing = [state for state in list_states(uuid) if state.get("feature") == FEATURE]
    payload = {"feature": FEATURE, "enabled": True, "feature_state_value": "control"}
    if existing:
        fs = existing[0]["featurestate_uuid"]
        url = f"https://api.flagsmith.com/api/v1/environments/{ENV}/edge-identities/{uuid}/edge-featurestates/{fs}/"
        status, data = req(url, "PUT", payload)
        print(f"put {status} {data}")
        return
    url = f"https://api.flagsmith.com/api/v1/environments/{ENV}/edge-identities/{uuid}/edge-featurestates/"
    status, data = req(url, "POST", payload)
    print(f"post {status} {data}")


def clear(identifier):
    uuid = edge_uuid(identifier)
    for state in list_states(uuid):
        if state.get("feature") != FEATURE:
            continue
        fs = state["featurestate_uuid"]
        url = f"https://api.flagsmith.com/api/v1/environments/{ENV}/edge-identities/{uuid}/edge-featurestates/{fs}/"
        status, data = req(url, "DELETE")
        print(f"delete {status} {data}")


if __name__ == "__main__":
    if not TOKEN:
        raise SystemExit("FLAGSMITH_ADMIN_API_TOKEN is required")
    if not ENV:
        raise SystemExit("FLAGSMITH_ENVIRONMENT_KEY is required")
    if not FEATURE_RAW:
        raise SystemExit("FLAGSMITH_FEATURE_ID is required")
    FEATURE = int(FEATURE_RAW)
    if len(sys.argv) < 3:
        raise SystemExit("usage: flagsmith-override.py set-control|clear IDENTIFIER")
    cmd, ident = sys.argv[1], sys.argv[2]
    if cmd == "set-control":
        set_control(ident)
    elif cmd == "clear":
        clear(ident)
    else:
        raise SystemExit("unknown command")
