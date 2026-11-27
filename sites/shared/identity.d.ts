export const IDENTITY_COOKIE: string;
export const IDENTITY_STORAGE_KEY: string;
export const IDENTITY_MAX_AGE_SEC: number;
export const IDENTITY_MAX_LENGTH: number;

export interface IdentityEnv {
  search: string;
  getCookie: () => string;
  setCookie: (value: string) => void;
  getStorage: () => string | null;
  setStorage: (value: string) => void;
  randomId: () => string;
  secure: boolean;
}

export function isUsableIdentity(value: unknown): value is string;
export function readQueryIdentity(search: string): string | null;
export function readCookieIdentity(header: string): string | null;
export function cookieWriteValue(id: string, secure: boolean): string;
export function resolveVisitorId(env: IdentityEnv): string;
export function browserIdentityEnv(): IdentityEnv;
