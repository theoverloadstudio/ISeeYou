'use strict';
ObjC.import('Foundation');

function run() {
  const task = $.NSTask.alloc.init;
  const output = $.NSPipe.pipe;
  task.executableURL = $.NSURL.fileURLWithPath('/usr/bin/curl');
  task.arguments = $.NSArray.arrayWithArray([
    '--disable', '--silent', '--proto', '=https', '--connect-timeout', '5',
    '--max-time', '10', '--max-filesize', '1048576',
    '--header', 'Accept: application/vnd.github+json', '--user-agent', 'ISeeYou',
    '--write-out', '\n%{http_code}',
    'https://api.github.com/repos/theoverloadstudio/ISeeYou/releases/latest'
  ]);
  task.standardOutput = output;
  task.standardError = $.NSFileHandle.fileHandleWithNullDevice;
  if (!task.launchAndReturnError(null)) return JSON.stringify({status: 0});

  const data = output.fileHandleForReading.readDataToEndOfFile;
  task.waitUntilExit;
  if (Number(task.terminationStatus) !== 0) return JSON.stringify({status: 0});

  const reply = $.NSString.alloc.initWithDataEncoding(data, 4).js;
  const split = reply.lastIndexOf('\n');
  const status = Number(reply.slice(split + 1));
  if (status !== 200) return JSON.stringify({status});

  const body = JSON.parse(reply.slice(0, split));
  return JSON.stringify({status, tag: body.tag_name});
}
