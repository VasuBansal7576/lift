import { handleRequest } from "./lib/handler.js";

export default {
  async fetch(request, env) {
    try {
      return await handleRequest(request, env);
    } catch {
      return new Response("not found", { status: 404 });
    }
  },
};

export { handleRequest };
