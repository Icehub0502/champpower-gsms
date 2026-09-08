import { createServer } from 'node:http';
import { app } from './app.js';
import { initSocket } from './lib/socket.js';

const port = Number(process.env.PORT) || 4000;

const server = createServer(app);
initSocket(server);

server.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`champpower-api listening on :${port}`);
});
