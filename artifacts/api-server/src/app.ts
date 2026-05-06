import express, { type Request, type Response } from 'express';
import pinoHttp from 'pino-http';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { logger } from './lib/logger';
import router from './routes/index';

const app = express();

app.use(pinoHttp({ logger }));
app.use(cors({ origin: '*' }));
app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use('/api', router);

app.get('/', (_req: Request, res: Response) => {
  res.json({ message: 'trynProxy is running' });
});

export default app;
