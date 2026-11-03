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

export default function resource(kind) {
  let executor;
  return {
    command: kind,
    description: `Manage repository ${kind} configuration`,
    builder: (yargs) => yargs.command({
      command: `add [${kind === 'user' ? 'email' : 'name'}]`,
      description: `Create a ${kind} configuration without overwriting existing entries`,
      builder: (args) => {
        args.positional(kind === 'user' ? 'email' : 'name', { type: 'string' });
        if (kind === 'user') {
          args.option('roles', { describe: 'User roles (space- or comma-separated)', type: 'string', array: true });
        } else {
          args.option('title', { describe: 'Title (defaults to the name)', type: 'string' });
        }
        if (kind === 'site') {
          args.option('profile', { describe: 'Existing profile to extend', type: 'string' })
            .option('source-type', {
              alias: 'sourceType', describe: 'Content source type (default: sourcebus)', type: 'string',
            })
            .option('source-url', {
              alias: 'sourceUrl', describe: 'External content source URL', type: 'string',
            });
        }
        return args.help();
      },
      handler: async (argv) => {
        if (!executor) {
          const AddCommand = (await import('./add.cmd.js')).default;
          executor = new AddCommand(getOrCreateLogger(argv), kind);
        }
        await executor.withDirectory(process.cwd()).withOptions(argv).run();
      },
    }).demandCommand(1, `You need at least one ${kind} subcommand.`).help(),
    handler: () => {},
  };
}
