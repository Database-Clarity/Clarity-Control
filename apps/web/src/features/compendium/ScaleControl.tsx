import { compendiumScales, useSettingsStore } from '../../stores/settings';
import styles from './Compendium.module.scss';

/** Compendium zoom (70–150 %), kept on this device: − / value / +. */
export function ScaleControl() {
  const scale = useSettingsStore((state) => state.device.compendiumScale);
  const updateDevice = useSettingsStore((state) => state.updateDevice);
  const index = Math.max(0, compendiumScales.indexOf(scale as (typeof compendiumScales)[number]));
  const step = (by: number) =>
    updateDevice({ compendiumScale: compendiumScales[index + by] ?? scale });
  return (
    <span className={styles.scale} role="group" aria-label="Compendium zoom">
      <button type="button" aria-label="Smaller" disabled={index === 0} onClick={() => step(-1)}>
        −
      </button>
      <output aria-live="polite">{scale}%</output>
      <button
        type="button"
        aria-label="Larger"
        disabled={index === compendiumScales.length - 1}
        onClick={() => step(1)}
      >
        +
      </button>
    </span>
  );
}
