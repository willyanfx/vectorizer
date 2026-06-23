import styles from './BuyMeACoffee.module.css'

/**
 * Buy Me a Coffee's `button.prod.min.js` loader only renders when parsed during
 * initial HTML parsing (it reads `document.currentScript` at parse time), so it
 * does nothing when injected dynamically by React. Instead we render a plain
 * link styled to match the official button — works everywhere, no blocking
 * external script, no dependency on their loader.
 */
const SLUG = 'willyanfx'

export function BuyMeACoffee() {
  return (
    <a
      className={styles.bmc}
      href={`https://www.buymeacoffee.com/${SLUG}`}
      target="_blank"
      rel="noopener noreferrer"
      aria-label="Buy me a coffee"
    >
      <span className={styles.emoji} aria-hidden="true">☕</span>
      <span className={styles.text}>Buy me a coffee</span>
    </a>
  )
}
