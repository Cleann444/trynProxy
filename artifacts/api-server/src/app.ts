import express, { Request, Response } from 'express';
import pino from 'pino-http';
import proxy from 'express-http-proxy';

const app = express();
const port = process.env.PORT || 3000;

const logger = pino({
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:standard',
      ignore: 'pid,hostname'
    }
  }
});

app.use(logger);

app.get('/', (req: Request, res: Response) => {
  res.json({ message: 'trynProxy is running' });
});

app.use('/proxy', proxy('https://example.com', {
  proxyReqPathResolver: (req: Request) => {
    const targetUrl = req.query.url as string;
    if (targetUrl) {
      try {
        const url = new URL(targetUrl);
        return url.pathname + url.search;
      } catch {
        return '/';
      }
    }
    return '/';
  }
}));

app.listen(port, () => {
  console.log(`trynProxy running on port ${port}`);
});

export default app;
