import { createRequestHandler } from "../local-server.mjs";

const handler = createRequestHandler();

export default async function vercelHandler(request, response) {
  return handler(request, response);
}
