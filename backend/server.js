import http from 'http';
import { handleApiRequest } from './app.js';

const PORT = parseInt(process.env.PORT || '8080', 10);
const server = http.createServer(handleApiRequest);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[Router API] Server listening on http://127.0.0.1:${PORT}`);
});
