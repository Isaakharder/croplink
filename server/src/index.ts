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
import stemGrowthMeasurementsRouter from './routes/stemGrowthMeasurements';
import blocksRouter from './routes/blocks';
import blockClimateSummaryRouter from './routes/blockClimateSummary';
import climateImportsRouter from './routes/climateImports';
import climatePingRouter from './routes/climatePing';
import climateImportBatchesRouter from './routes/climateImportBatches';
import varietyClimateHourlyRouter from './routes/varietyClimateHourly';
import varietyClimateFeaturesRouter from './routes/varietyClimateFeatures';
import climateFeatureConfigRouter from './routes/climateFeatureConfig';
import climateTrainingDatasetRouter from './routes/climateTrainingDataset';
import phasesRouter from './routes/phases';
import zonesRouter from './routes/zones';
import varietyZonesRouter from './routes/varietyZones';
import growlinkVarietyLinksRouter from './routes/growlinkVarietyLinks';
import growlinkHarvestActualsRouter from './routes/growlinkHarvestActuals';
import growlinkConnectionRouter from './routes/growlinkConnection';

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
app.use(`${api}/stem-growth-measurements`, stemGrowthMeasurementsRouter);
app.use(`${api}/climate-training-dataset`, climateTrainingDatasetRouter);

const climateApi = '/api/climate';
app.use(`${climateApi}/blocks`, blocksRouter);
app.use(`${climateApi}/block-summary`, blockClimateSummaryRouter);
app.use(`${climateApi}/import-batches`, climateImportBatchesRouter);
app.use(`${climateApi}/variety-hourly`, varietyClimateHourlyRouter);
app.use(`${climateApi}/variety-features`, varietyClimateFeaturesRouter);
app.use(`${climateApi}/feature-config`, climateFeatureConfigRouter);

app.use('/api/v1/climate/imports', climateImportsRouter);
app.use('/api/v1/climate/ping', climatePingRouter);

const setupApi = '/api/setup';
app.use(`${setupApi}/phases`, phasesRouter);
app.use(`${setupApi}/zones`, zonesRouter);
app.use(`${setupApi}/variety-zones`, varietyZonesRouter);

const growlinkApi = '/api/growlink';
app.use(`${growlinkApi}/connection`, growlinkConnectionRouter);
app.use(`${growlinkApi}/variety-links`, growlinkVarietyLinksRouter);
app.use(`${growlinkApi}/harvest-actuals`, growlinkHarvestActualsRouter);

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
