'use strict';
ObjC.import('AVFoundation');

// Sample a bounded window in each time bin. This keeps large recordings inexpensive.
function run(argv) {
  const url = $.NSURL.fileURLWithPath(argv[0]);
  const file = $.AVAudioFile.alloc.initForReadingCommonFormatInterleavedError(url, 1, true, null);
  if (file.isNil()) return '[]';

  const frames = Number(file.length);
  const channels = Number(file.processingFormat.channelCount);
  if (frames < 1 || channels < 1) return '[]';

  const bins = Math.min(96, frames);
  const capacity = Math.min(4096, Math.max(1, Math.floor(16384 / channels)));
  const buffer = $.AVAudioPCMBuffer.alloc.initWithPCMFormatFrameCapacity(file.processingFormat, capacity);
  if (buffer.isNil()) return '[]';

  const peaks = [];
  for (let bin = 0; bin < bins; bin++) {
    const start = Math.floor(bin * frames / bins);
    const end = Math.floor((bin + 1) * frames / bins);
    const count = Math.min(capacity, end - start);
    const position = start + Math.floor((end - start - count) / 2);
    if (Number(file.framePosition) !== position) file.framePosition = position;
    if (!file.readIntoBufferFrameCountError(buffer, count, null) || !buffer.frameLength) return '[]';

    const samples = Number(buffer.frameLength) * channels;
    const data = $.NSData.dataWithBytesLength(buffer.floatChannelData[0], samples * 4);
    const floats = decodeFloat32(data.base64EncodedStringWithOptions(0).js, samples);
    let peak = 0;
    for (const sample of floats) {
      if (Number.isFinite(sample)) peak = Math.max(peak, Math.abs(sample));
    }
    peaks.push(Math.round(Math.min(1, peak) * 1000) / 1000);
  }
  return JSON.stringify(peaks);
}

function decodeFloat32(encoded, sampleCount) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const bytes = new Uint8Array(sampleCount * 4);
  let value = 0, bits = 0, index = 0;
  for (const char of encoded) {
    const digit = alphabet.indexOf(char);
    if (digit < 0) break;
    value = (value << 6) | digit;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[index++] = (value >>> bits) & 255;
    }
  }
  return new Float32Array(bytes.buffer);
}
