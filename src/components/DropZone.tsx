import { useCallback, useRef, useState } from 'react'
import styles from './DropZone.module.css'

interface Props {
  onFile: (file: File) => void
  disabled?: boolean
}

const ACCEPT = 'image/png,image/jpeg,image/webp,image/gif,image/bmp'

export function DropZone({ onFile, disabled }: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)

  const handleFiles = useCallback(
    (files: FileList | null) => {
      if (!files || files.length === 0) return
      const file = Array.from(files).find((f) => f.type.startsWith('image/'))
      if (file) onFile(file)
    },
    [onFile],
  )

  return (
    <div
      className={`${styles.zone} ${dragging ? styles.dragging : ''} ${disabled ? styles.disabled : ''}`}
      onClick={() => !disabled && inputRef.current?.click()}
      onDragOver={(e) => {
        e.preventDefault()
        if (!disabled) setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        if (!disabled) handleFiles(e.dataTransfer.files)
      }}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if ((e.key === 'Enter' || e.key === ' ') && !disabled) inputRef.current?.click()
      }}
      aria-label="Upload an image to vectorize"
    >
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        hidden
        onChange={(e) => handleFiles(e.target.files)}
      />
      <svg className={styles.icon} viewBox="0 0 24 24" aria-hidden width="40" height="40">
        <path
          fill="currentColor"
          d="M19 13v6H5v-6H3v6a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-6h-2zM11 3.83 7.41 7.41 6 6l6-6 6 6-1.41 1.41L13 3.83V15h-2V3.83z"
        />
      </svg>
      <p className={styles.title}>Drop an image, or click to browse</p>
      <p className={styles.hint}>PNG · JPG · WebP · GIF · BMP</p>
    </div>
  )
}
