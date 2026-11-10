import styles from './Landing.module.css'

// Shown in the preview area until an image is loaded. Plain, crawlable content:
// how it works, what it does, and an FAQ. Keep the FAQ in sync with the
// FAQPage structured data in index.html (Google requires them to match).

const STEPS = [
  {
    title: 'Drop an image',
    body: 'PNG, JPG, WebP, GIF or BMP. It is decoded on your device and never uploaded.',
  },
  {
    title: 'Tune the trace',
    body: 'Pick a preset or adjust every tracing setting, and compare the vector against the original with a live split view.',
  },
  {
    title: 'Download',
    body: 'Get a layered SVG, a size-optimized SVG, or a Lottie JSON file ready to animate.',
  },
]

const FEATURES = [
  {
    title: 'Private by design',
    body: 'Tracing runs in your browser with WebAssembly and WebGPU. Your images stay on your device.',
  },
  {
    title: 'Free and unlimited',
    body: 'No sign-up, no credits, no watermark and no file-size cap beyond what your browser can handle.',
  },
  {
    title: 'Editable layers',
    body: 'Shapes are grouped into layers by color, so the SVG opens with a clean layer list in Figma, Illustrator or Inkscape.',
  },
  {
    title: 'Background removal',
    body: 'The background color is detected from the image border and can be dropped with one toggle.',
  },
  {
    title: 'SVG and Lottie export',
    body: 'Download SVG, SVGO-optimized SVG, or Lottie JSON with one shape layer per SVG layer.',
  },
  {
    title: 'Full control',
    body: 'Presets for photos, flat illustrations, line art, pixel art and text, plus every VTracer setting.',
  },
]

const FAQ = [
  {
    q: 'How do I convert an image to SVG for free?',
    a: 'Drop a PNG, JPG, WebP, GIF or BMP image onto Vector. It traces the image into a scalable SVG right in your browser, and you can download the result as SVG or Lottie. There is no sign-up, no watermark and no limit.',
  },
  {
    q: 'Are my images uploaded to a server?',
    a: 'No. Tracing runs entirely in your browser using WebAssembly and, when available, WebGPU. The one exception is the optional AI layer naming: it only runs when you click it, and it sends a downscaled copy of the image to Anthropic using your own API key.',
  },
  {
    q: 'Is there a limit on how many images I can convert?',
    a: 'No. Because conversion happens on your own device, there are no credits, quotas or daily limits.',
  },
  {
    q: 'Which formats are supported?',
    a: 'You can upload PNG, JPG/JPEG, WebP, GIF and BMP images. You can download SVG, optimized SVG, or Lottie JSON.',
  },
  {
    q: 'Will the SVG have layers I can edit?',
    a: 'Yes. Paths are grouped into layers by color, and the background gets its own layer, so the file opens with a tidy layer list in Figma, Illustrator or Inkscape. Optional AI naming can group shapes into layers like "logo-icon" or "text-heading".',
  },
  {
    q: 'Can I remove the background?',
    a: 'Yes. Vector detects the background color from the image border. Untick "Keep background color" and that layer is left out of the preview and every download.',
  },
  {
    q: 'Can I animate the result?',
    a: 'Yes. Download it as Lottie JSON: each layer becomes a Lottie shape layer, ready to animate in a Lottie editor or play with any Lottie player.',
  },
]

export function Landing() {
  return (
    <div className={styles.wrap}>
      <div className={styles.inner}>
        <section className={styles.hero}>
          <h2>Convert images to SVG, privately and for free</h2>
          <p>
            Turn PNG, JPG and other raster images into clean, layered vectors. Everything runs in your
            browser, so there&rsquo;s nothing to upload and no limit on how many images you convert.
          </p>
          <p className={styles.cta}>Drop an image to get started.</p>
        </section>

        <section aria-labelledby="how-heading">
          <h2 id="how-heading" className={styles.sectionTitle}>
            How it works
          </h2>
          <ol className={styles.steps}>
            {STEPS.map((s) => (
              <li key={s.title}>
                <h3>{s.title}</h3>
                <p>{s.body}</p>
              </li>
            ))}
          </ol>
        </section>

        <section aria-labelledby="features-heading">
          <h2 id="features-heading" className={styles.sectionTitle}>
            Features
          </h2>
          <ul className={styles.features}>
            {FEATURES.map((f) => (
              <li key={f.title}>
                <h3>{f.title}</h3>
                <p>{f.body}</p>
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="faq-heading">
          <h2 id="faq-heading" className={styles.sectionTitle}>
            Frequently asked questions
          </h2>
          <div className={styles.faq}>
            {FAQ.map((item) => (
              <details key={item.q}>
                <summary>{item.q}</summary>
                <p>{item.a}</p>
              </details>
            ))}
          </div>
        </section>
      </div>
    </div>
  )
}
