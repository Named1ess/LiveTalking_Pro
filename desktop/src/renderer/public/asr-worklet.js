class LiveTalkingAsrProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) {
      return true;
    }

    const channel = input[0];
    if (!channel || channel.length === 0) {
      return true;
    }

    const samples = new Float32Array(channel.length);
    samples.set(channel);
    this.port.postMessage({ type: "audio", samples }, [samples.buffer]);
    return true;
  }
}

registerProcessor("livetalking-asr-processor", LiveTalkingAsrProcessor);
