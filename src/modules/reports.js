import { getDashboard, updateDashboard } from './dashboard.js';
import { getRedirectForUrl } from './redirectMonitor.js';

/** Builds and stores a structured report for a completed URL scan. */
export async function createSecurityReport(result, contentFindings = null) {
  const data = await getDashboard();
  const redirect = await getRedirectForUrl(result.url);
  const report = {
    url: result.url, timestamp: Date.now(), riskScore: result.score, riskLabel: result.label,
    httpsStatus: Boolean(result.isHttps), redirectCount: redirect?.count || 0,
    permissionsRequested: data.permissions.filter(item => item.url === result.url).map(item => item.permission),
    downloads: data.downloads.filter(item => item.url === result.url || item.referrer === result.url),
    contentFindings: contentFindings || result.contentFindings || null,
  };
  await updateDashboard(dashboard => { dashboard.reports = [report, ...dashboard.reports].slice(0, 100); });
  return report;
}
