// The tvpipe.party Worker's entry point. Its module may export only
// handlers and Durable Object classes (workerd rejects other named
// exports), so the logic is in app.ts and room.ts.

import { handle } from "./app.ts";
import type { Env } from "./env.ts";

export { Room } from "./room.ts";

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handle(request, env);
  },
};
