import { handleRequest } from "./lib/handler.js";

export default {
  async fetch(request, env) {
    try {
      return await handleRequest(request, env);
    } catch {
      return new Response("lift edge fail-open", { status: 502 });
    }
  },
};

export { handleRequest };
