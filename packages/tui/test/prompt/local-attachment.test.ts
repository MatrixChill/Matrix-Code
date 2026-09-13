import { describe, expect, test } from "bun:test"
import { readLocalAttachmentWith } from "../../src/component/prompt/local-attachment"
import type { LocalFiles } from "../../src/component/prompt/local-attachment"

function files(input: { mime: string; text?: string; bytes?: Uint8Array }): LocalFiles {
  return {
    mime: async () => input.mime,
    readText: async () => input.text ?? "",
    readBytes: async () => input.bytes ?? new Uint8Array(),
  }
}

describe("prompt local attachments", () => {
  test("reads SVG attachments as text", async () => {
    expect(await readLocalAttachmentWith(files({ mime: "image/svg+xml", text: "<svg />" }), "/tmp/image.svg")).toEqual({
      type: "text",
      mime: "image/svg+xml",
      content: "<svg />",
    })
  })

  test("reads image and PDF attachments as bytes", async () => {
    const content = new Uint8Array([1, 2, 3])
    expect(await readLocalAttachmentWith(files({ mime: "application/pdf", bytes: content }), "/tmp/file.pdf")).toEqual({
      type: "binary",
      mime: "application/pdf",
      content,
    })
  })

  test("accepts PNG, JPEG, and WebP paths including Windows paths with spaces", async () => {
    const content = new Uint8Array([1, 2, 3])
    for (const [file, mime] of [
      ["C:\\Users\\Matrix User\\Pictures\\error shot.PNG", "image/png"],
      ["C:\\Users\\Matrix User\\Pictures\\interface.jpeg", "image/jpeg"],
      ["C:\\Users\\Matrix User\\Pictures\\diagram.webp", "image/webp"],
    ] as const) {
      let received = ""
      expect(
        await readLocalAttachmentWith(
          {
            mime: async (path) => {
              received = path
              return mime
            },
            readText: async () => "",
            readBytes: async () => content,
          },
          file,
        ),
      ).toEqual({ type: "binary", mime, content })
      expect(received).toBe(file)
    }
  })

  test("ignores unsupported and unreadable local files", async () => {
    expect(await readLocalAttachmentWith(files({ mime: "text/plain" }), "/tmp/file.txt")).toBeUndefined()
    expect(
      await readLocalAttachmentWith(
        {
          ...files({ mime: "image/png" }),
          readBytes: async () => Promise.reject(new Error("missing")),
        },
        "/tmp/missing.png",
      ),
    ).toBeUndefined()
  })
})
