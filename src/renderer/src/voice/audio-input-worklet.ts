import processorModuleUrl from './audio-input-worklet-processor.js?url&no-inline'

const PROCESSOR_NAME = 'crewcode-pcm-capture'

export interface AudioInputWorklet {
  node: AudioWorkletNode
  dispose: () => void
}

/**
 * Create a microphone PCM tap using the non-deprecated AudioWorklet API.
 * The processor is emitted as a same-origin build asset instead of an executable
 * blob URL, which keeps it compatible with CrewCode's production script CSP.
 * Callers still connect the returned node through a zero-gain sink so Chromium
 * keeps the graph active without playing microphone input.
 */
export async function createAudioInputWorklet(
  context: AudioContext,
  onSamples: (samples: Float32Array) => void,
  frameSize = 2048,
): Promise<AudioInputWorklet> {
  if (!context.audioWorklet) throw new Error('AudioWorklet is unavailable in this Chromium runtime')
  await context.audioWorklet.addModule(processorModuleUrl)

  const node = new AudioWorkletNode(context, PROCESSOR_NAME, {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    processorOptions: { frameSize },
  })
  const onMessage = (event: MessageEvent<ArrayBuffer>) => {
    if (event.data instanceof ArrayBuffer) onSamples(new Float32Array(event.data))
  }
  node.port.addEventListener('message', onMessage)
  node.port.start()
  return {
    node,
    dispose: () => {
      node.port.removeEventListener('message', onMessage)
      node.port.close()
      node.disconnect()
    },
  }
}
