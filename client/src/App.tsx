import { BrowserRouter, Routes, Route, Outlet } from 'react-router-dom';
import { Sidebar } from './components/Sidebar';
import { DashboardPage } from './pages/DashboardPage';
import { MeasurementsPage } from './pages/MeasurementsPage';
import { CalculatorPage } from './pages/CalculatorPage';
import { HarvestedPage } from './pages/HarvestedPage';
import { ProjectionsPage } from './pages/ProjectionsPage';
import { ClimatePage } from './pages/ClimatePage';
import { SetupPage } from './pages/SetupPage';
import { MobileMeasurementsPage } from './pages/MobileMeasurementsPage';
import { RowCanvasPage } from './pages/RowCanvasPage';

function DesktopLayout() {
  return (
    <div className="app-layout">
      <Sidebar />
      <div className="main-content">
        <Outlet />
      </div>
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/mobile" element={<MobileMeasurementsPage />} />
        <Route path="/mobile/measurements" element={<MobileMeasurementsPage />} />
        <Route path="/mobile/row/:rowId" element={<RowCanvasPage />} />
        <Route element={<DesktopLayout />}>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/measurements" element={<MeasurementsPage />} />
            <Route path="/calculator" element={<CalculatorPage />} />
            <Route path="/harvested" element={<HarvestedPage />} />
            <Route path="/projections" element={<ProjectionsPage />} />
            <Route path="/climate" element={<ClimatePage />} />
            <Route path="/setup" element={<SetupPage />} />
          </Route>
      </Routes>
    </BrowserRouter>
  );
}
