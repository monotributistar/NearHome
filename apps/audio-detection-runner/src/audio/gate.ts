export type RmsGateConfig = {
  minVolume: number;
};

export class RmsGate {
  private readonly minVolume: number;

  constructor(config: RmsGateConfig) {
    this.minVolume = Math.max(0, config.minVolume);
  }

  shouldPass(rms: number): boolean {
    if (!Number.isFinite(rms)) return false;
    return rms >= this.minVolume;
  }
}
