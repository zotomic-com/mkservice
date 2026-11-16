"""Generate narration + per-word timings for the video generator.

Usage: python video_voice.py <text> <voice> <out_media.mp3> <out_words.json>

Uses the edge-tts streaming API so we get exact WordBoundary events (the CLI
subtitle file only has sentence-level cues). Offsets are in 100-ns ticks.
"""

import asyncio
import json
import sys

import edge_tts


async def main() -> None:
    text, voice, out_media, out_words = sys.argv[1:5]
    rate = sys.argv[5] if len(sys.argv) > 5 else "+0%"
    pitch = sys.argv[6] if len(sys.argv) > 6 else "+0Hz"
    words = []
    com = edge_tts.Communicate(text, voice, boundary="WordBoundary", rate=rate, pitch=pitch)
    with open(out_media, "wb") as f:
        async for chunk in com.stream():
            if chunk["type"] == "audio":
                f.write(chunk["data"])
            elif chunk["type"] == "WordBoundary":
                words.append(
                    {
                        "w": chunk["text"],
                        "start": round(chunk["offset"] / 1e7, 3),
                        "end": round((chunk["offset"] + chunk["duration"]) / 1e7, 3),
                    }
                )
    with open(out_words, "w", encoding="utf-8") as f:
        json.dump(words, f, ensure_ascii=False)


if __name__ == "__main__":
    asyncio.run(main())
