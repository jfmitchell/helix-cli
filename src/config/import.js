/*
 * Copyright 2026 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */
import { getOrCreateLogger } from '../log-common.js';

export default function importConfig() {
  let executor;
  return {
    command: 'import',
    description: 'Import deployed organisation configuration into site-config/',
    builder: (yargs) => yargs
      .option('dry-run', {
        alias: 'dryRun', describe: 'Preview imported file changes without writing', type: 'boolean', default: false,
      })
      .option('overwrite', {
        describe: 'Replace existing site-config/ after preview and confirmation', type: 'boolean', default: false,
      })
      .option('yes', {
        describe: 'Confirm an explicitly requested --overwrite without prompting', type: 'boolean', default: false,
      })
      .help(),
    handler: async (argv) => {
      if (!executor) {
        const ImportCommand = (await import('./import.cmd.js')).default;
        executor = new ImportCommand(getOrCreateLogger(argv));
      }
      await executor.withDirectory(process.cwd()).withOptions(argv).run();
    },
  };
}
