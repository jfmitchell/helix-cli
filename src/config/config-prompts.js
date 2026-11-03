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
import readline from 'node:readline';
import { prompt } from '../cli-util.js';

export default class ConfigPrompts {
  constructor(log, input = process.stdin, output = process.stdout) {
    this.log = log;
    this.input = input;
    this.output = output;
  }

  requireInputs(missing) {
    if (missing.length && (!this.input.isTTY || !this.output.isTTY)) {
      throw new Error(`Missing mandatory inputs: ${missing.join(', ')}. Supply these arguments/flags.`);
    }
  }

  async ask(question, validate = (value) => value) {
    if (!this.input.isTTY || !this.output.isTTY) {
      throw new Error(`Missing input: ${question}. Supply the mandatory arguments/flags.`);
    }
    const rl = readline.createInterface({ input: this.input, output: this.output });
    let cancel;
    const cancelled = new Promise((resolve, reject) => {
      cancel = () => reject(new Error('Configuration operation cancelled'));
    });
    rl.once('close', cancel);
    rl.once('SIGINT', cancel);
    try {
      for (;;) {
        // eslint-disable-next-line no-await-in-loop
        const answer = await Promise.race([prompt(rl, `${question}: `), cancelled]);
        try {
          return validate(String(answer).trim());
        } catch (error) {
          this.log.warn(error.message);
        }
      }
    } finally {
      rl.removeListener('close', cancel);
      rl.removeListener('SIGINT', cancel);
      rl.close();
    }
  }

  async confirm(question, assumeYes = false) {
    if (assumeYes) {
      return;
    }
    if (!this.input.isTTY || !this.output.isTTY) {
      throw new Error('Replacement needs confirmation; use --overwrite --yes in scripts');
    }
    const answer = await this.ask(`${question} [y/N]`);
    if (!/^y(es)?$/i.test(answer)) {
      throw new Error('Configuration operation cancelled');
    }
  }
}
