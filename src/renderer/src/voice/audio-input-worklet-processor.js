// Runs inside AudioWorkletGlobalScope, not the renderer window. Keep this file
// as a standalone module so the production CSP can load it from 'self' without
// allowing executable blob: URLs.
const PROCESSOR_NAME = 'crewcode-pcm-capture'

class CrewCodePcmCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super()
    const requested = options.processorOptions && options.processorOptions.frameSize
    this.frameSize = Number.isFinite(requested) ? Math.max(128, requested) : 2048
    this.buffer = new Float32Array(this.frameSize)
    this.offset = 0
  }

  process(inputs, outputs) {
    const input = inputs[0] && inputs[0][0]
    if (input) {
      let sourceOffset = 0
      while (sourceOffset < input.length) {
        const count = Math.min(input.length - sourceOffset, this.frameSize - this.offset)
        this.buffer.set(input.subarray(sourceOffset, sourceOffset + count), this.offset)
        this.offset += count
        sourceOffset += count
        if (this.offset === this.frameSize) {
          const complete = this.buffer
          this.port.postMessage(complete.buffer, [complete.buffer])
          this.buffer = new Float32Array(this.frameSize)
          this.offset = 0
        }
      }
    }
    const output = outputs[0] && outputs[0][0]
    if (output) output.fill(0)
    return true
  }
}

registerProcessor(PROCESSOR_NAME, CrewCodePcmCaptureProcessor)
