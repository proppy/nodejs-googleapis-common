// Copyright 2019, Google, LLC.
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//    http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import * as http2 from 'http2';
import * as url from 'url';
import * as qs from 'qs';
import {Stream} from 'stream';
import {Headers} from 'gaxios';

export type Method = 'GET' | 'POST' | 'DELETE' | 'HEAD' | 'PUT';

export interface MooRequestConfig {
  url: string;
  method?: Method;
  data?: {};
  headers?: http2.OutgoingHttpHeaders;
  params?: {};
}

export interface MooResponse<T> {
  config: MooRequestConfig;
  request: http2.ClientHttp2Stream;
  data: T;
  status: number;
  statusText: string;
  headers: Headers;
}

interface SessionData {
  client: http2.ClientHttp2Session;
  timeoutHandle?: NodeJS.Timer;
}

export class H2MOO {
  private sessions: {[index: string]: SessionData} = {};

  /**
   * Public method to make an http2 request.
   * @param config
   */
  moo<T>(config: MooRequestConfig): Promise<MooResponse<T>> {
    return new Promise((resolve, reject) => {
      const urlParts = url.parse(config.url);
      const host = urlParts.host!;

      // Check for an existing session to this host, or go create a new one.
      const session = this._getClient(host);

      // Since we're using this session, clear the timeout handle to ensure
      // it stays in memory and connected for a while further.
      if (session.timeoutHandle !== undefined) {
        clearTimeout(session.timeoutHandle);
      }

      // Assemble the querystring based on config.params.  We're using the
      // `qs` module to make life a little easier.
      let pathWithQs = urlParts.path!;
      if (config.params) {
        const q = qs.stringify(config.params);
        pathWithQs += `?${q}`;
      }

      // Assemble the headers based on basic HTTP2 primitives (path, method) and
      // custom headers sent from the consumer.  Note: I am using `Object.assign`
      // here making the assumption these objects are not deep.  If it turns out
      // they are, we may need to use the `extend` npm module for deep cloning.
      const headers = Object.assign({}, config.headers, {
        ':path': pathWithQs,
        ':method': config.method,
        'content-type': 'application/json',
      });

      // Right now gzip encoding is not working.  I keep getting an
      // 'Error: incorrect header check' when trying to deflate the stream,
      // so I'm punting this for now.
      delete headers['Accept-Encoding'];

      const req = session.client.request(headers);
      req.setEncoding('utf8');

      let data = '';
      let incomingHeaders: http2.IncomingHttpHeaders;
      req
        .on('data', d => {
          console.log(`*DATA*: ${d}`);
          data += d;
        })
        .on('response', (headers, flags) => {
          console.log(`*RESPONSE*\n`);
          for (const name in headers) {
            if (headers[name]) {
              console.log(`\t${name}: ${headers[name]}`);
            }
          }
          incomingHeaders = headers;
        })
        .on('error', e => {
          console.log('*ERROR*:' + e);
          reject(e);
          return;
        })
        .on('end', () => {
          console.log(`*END*`);
          console.log(`DATA DATA: ${data}`);
          const res: MooResponse<T> = {
            data: JSON.parse(data),
            config,
            request: req,
            headers: incomingHeaders,
            status: Number(incomingHeaders[':status']),
            statusText: '',
          };
          resolve(res);
          return;
        });

      // If data was provided, write it to the request in the form of
      // a stream, string data, or a basic object.
      if (config.data) {
        if (config.data instanceof Stream) {
          config.data.pipe(req);
        } else if (typeof config.data === 'string') {
          const data = Buffer.from(config.data);
          req.end(data);
        } else if (typeof config.data === 'object') {
          const data = JSON.stringify(config.data);
          req.end(data);
        }
      }

      // Create a timeout so the Http2Session will be cleaned up after
      // a period of non-use. 500 milliseconds was chosen because it's
      // a nice round number, and I don't know what would be a better
      // choice. Keeping this channel open will hold a file descriptor
      // which will prevent the process from exiting.
      session.timeoutHandle = setTimeout(() => {
        session.client.close(() => {
          delete this.sessions[host];
        });
      }, 500);
    });
  }

  /**
   * Obtain an existing h2 session or go create a new one.
   */
  private _getClient(host: string): SessionData {
    if (!this.sessions[host]) {
      const client = http2.connect(`https://${host}`);
      client
        .on('error', e => {
          console.error(`*ERROR*: ${e}`);
        })
        .on('goaway', (errorCode, lastStreamId, opaqueData) => {
          console.error(`*GOAWAY*: ${errorCode} : ${lastStreamId}`);
        });
      this.sessions[host] = {client};
    }
    return this.sessions[host];
  }
}

const h2 = new H2MOO();
export {h2};
