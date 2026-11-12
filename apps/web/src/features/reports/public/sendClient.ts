/**
 * What only Send needs: the shared submission schemas (classic zod) and the submit and upload
 * calls. ReportForm loads this once a draft has content, so a direct link's first paint does not.
 */
export {
  reportSubmissionSchema,
  reportVideoHosts,
  reportVideoSchema,
} from '../../../../../../packages/core/src/reports/schemas';
export { submitReport, uploadScreenshot } from '../../../services/reportAccount';
