import { relative } from 'node:path';

// Flush progress as events arrive, so forced termination preserves the last
// active file/test even when Vitest cannot finish its JSON report.
export default class ReviewSuiteReporter {
  onTestModuleStart(module) {
    this.log('FILE START', module.moduleId);
  }

  onTestModuleEnd(module) {
    this.log('FILE FINISH', module.moduleId, module.state());
  }

  onTestCaseReady(test) {
    this.log('TEST START', test.module.moduleId, test.fullName);
  }

  onTestCaseResult(test) {
    this.log('TEST FINISH', test.module.moduleId, `${test.fullName} (${test.result().state})`);
  }

  log(event, moduleId, detail = '') {
    const file = relative(process.cwd(), moduleId).replaceAll('\\', '/');
    process.stdout.write(`${new Date().toISOString()} ${event} ${file} ${detail}\n`);
  }
}
