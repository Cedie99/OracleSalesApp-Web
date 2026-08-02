/**
 * Profile photo helpers shared by the avatar picker in User Management.
 *
 * The picked file is downscaled to a square JPEG in the browser before it ever
 * reaches a Server Action. That keeps the request far under Next's 1 MB action
 * body limit and means every avatar in the bucket lands as `avatar.jpg`, the
 * path convention migration 012 established with the mobile app.
 */

export const AVATAR_ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp']
export const AVATAR_ACCEPT_ATTR = AVATAR_ACCEPTED_TYPES.join(',')

/** Guard on the file the admin picks, before we spend memory decoding it. */
export const AVATAR_MAX_SOURCE_BYTES = 5 * 1024 * 1024

/** Longest edge of the stored image. */
export const AVATAR_SIZE = 512

/** Centre-crops to a square and re-encodes as a small JPEG named avatar.jpg. */
export async function resizeAvatar(file: File): Promise<File> {
  const bitmap = await createImageBitmap(file)
  try {
    const side = Math.min(bitmap.width, bitmap.height)
    const target = Math.min(side, AVATAR_SIZE)

    const canvas = document.createElement('canvas')
    canvas.width = target
    canvas.height = target

    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Canvas is unavailable in this browser.')

    ctx.drawImage(
      bitmap,
      (bitmap.width - side) / 2,
      (bitmap.height - side) / 2,
      side,
      side,
      0,
      0,
      target,
      target
    )

    const blob = await new Promise<Blob | null>(resolve =>
      canvas.toBlob(resolve, 'image/jpeg', 0.85)
    )
    if (!blob) throw new Error('Could not encode the image.')

    return new File([blob], 'avatar.jpg', { type: 'image/jpeg' })
  } finally {
    bitmap.close()
  }
}
