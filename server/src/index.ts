import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import { errorHandler } from './middleware/errorHandler';
import seasonsRouter from './routes/seasons';
import yearsRouter from './routes/years';
import varietiesRouter from './routes/varieties';
import rowsRouter from './routes/rows';
import stemsRouter from './routes/stems';
import nodesRouter from './routes/nodes';
import weeklyStatusesRouter from './routes/weeklyStatuses';
import measurementSummaryRouter from './routes/measurementSummary';
import harvestTimingRouter from './routes/harvestTiming';
import fruitWeightsRouter from './routes/fruitWeights';
import harvestedRouter from './routes/harvested';
import projectionRouter from './routes/projection';
import mobileRowsRouter from './routes/mobileRows';
import fruitSetByWeekRouter from './routes/fruitSetByWeek';
import harvestProjectionsRouter from './routes/harvestProjections';
import ripeningActualsRouter from './routes/ripeningActuals';
import breakerLearningRouter from './routes/breakerLearning';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json());

// API routes
const api = '/api/projection';
app.use(`${api}/seasons`, seasonsRouter);
app.use(`${api}/years`, yearsRouter);
app.use(`${api}/varieties`, varietiesRouter);
app.use(`${api}/rows`, rowsRouter);
app.use(`${api}/stems`, stemsRouter);
app.use(`${api}/nodes`, nodesRouter);
app.use(`${api}/weekly-statuses`, weeklyStatusesRouter);
app.use(`${api}/measurement-summary`, measurementSummaryRouter);
app.use(`${api}/harvest-timing`, harvestTimingRouter);
app.use(`${api}/fruit-weights`, fruitWeightsRouter);
app.use(`${api}/harvested`, harvestedRouter);
app.use(`${api}/projection`, projectionRouter);
app.use(`${api}/mobile/rows`, mobileRowsRouter);
app.use(`${api}/fruit-set-by-week`, fruitSetByWeekRouter);
app.use(`${api}/harvest-projections`, harvestProjectionsRouter);
app.use(`${api}/ripening-actuals`, ripeningActualsRouter);
app.use(`${api}/breaker-learning`, breakerLearningRouter);

// Serve static files from client build in production
if (process.env.NODE_ENV === 'production') {
  const clientDist = path.join(__dirname, '../../client/dist');
  app.use(express.static(clientDist));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`GrowLink Projection server running on port ${PORT}`);
});

export default app;
