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

export default function deploy() {
  let executor;
  return {
    set executor(value) {
      executor = value;
    },
    command: 'deploy',
    description: 'Deploy repository users, profiles and sites to the AEM Admin API',
    builder: (yargs) => yargs
      .option('dry-run', {
        alias: 'dryRun',
        describe: 'Read live config and report changes without writing',
        type: 'boolean',
        default: false,
      })
      .option('prune', {
        describe: 'Delete ALL organisation users, sites and profiles absent from the repo',
        type: 'boolean',
        default: false,
      })
      .help(),
    handler: async (argv) => {
      if (!executor) {
        const DeployCommand = (await import('./deploy.cmd.js')).default;
        executor = new DeployCommand(getOrCreateLogger(argv));
      }
      await executor
        .withDirectory(process.cwd())
        .withDryRun(argv.dryRun)
        .withPrune(argv.prune)
        .run();
    },
  };
}
