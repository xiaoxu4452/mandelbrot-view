// FFmpeg seed: format lookup, output-context allocation and AVIO open/close.
//
// av_guess_format, avformat_alloc_output_context2, avio_open and avio_close
// come from avformat/avutil.  The replacements keep the object model and the
// error conventions (negative return code on failure) while using our own
// file IO.

#include "video.hpp"
#include "../port.hpp"

#include <cstring>

namespace mset::port::video {

namespace {
const Format kFormats[] = {
    {"avi", "AVI (Audio Video Interleaved)", "avi", 1},
    {"mjpeg", "raw MJPEG", "mjpg", 1},
    {"image2", "image sequence", "ppm", 0},
};
}  // namespace

const Format* guess_format(const char* short_name, const char* filename,
                           const char* /*mime_type*/) {
    if (short_name && *short_name) {
        for (const Format& f : kFormats) {
            if (std::strcmp(f.name, short_name) == 0) return &f;
        }
    }
    if (filename) {
        // Extension match, case-insensitive on the suffix.
        std::size_t dot = std::string(filename).find_last_of('.');
        if (dot != std::string::npos) {
            std::string ext = std::string(filename).substr(dot + 1);
            for (const Format& f : kFormats) {
                if (ext == f.default_extension) return &f;
            }
        }
    }
    return nullptr;
}

FormatContext* alloc_output_context2(const Format* format, const char* filename) {
    const Format* chosen = format ? format : guess_format(nullptr, filename, nullptr);
    if (!chosen) return nullptr;
    FormatContext* ctx = new FormatContext();
    ctx->oformat = chosen;
    return ctx;
}

int io_open(IOContext** pb, const char* path, int flags) {
    if (!pb || !path) return -22;  // EINVAL
    IOContext* io = new IOContext();
    io->path = path;
    io->writable = (flags & 1) != 0;
    io->file = std::fopen(path, io->writable ? "wb" : "rb");
    if (!io->file) { delete io; return -2; }  // ENOENT
    *pb = io;
    return 0;
}

int io_close(IOContext* pb) {
    if (!pb) return -22;
    int rc = 0;
    if (pb->file) {
        if (std::fflush(pb->file) != 0) rc = -5;  // EIO
        if (std::fclose(pb->file) != 0) rc = -5;
        pb->file = nullptr;
    }
    delete pb;
    return rc;
}

int free_format_context(FormatContext* ctx) {
    if (!ctx) return -22;
    for (Stream* s : ctx->streams) {
        if (s) {
            delete s->codec;
            delete s;
        }
    }
    ctx->streams.clear();
    if (ctx->pb) io_close(ctx->pb);
    delete ctx;
    return 0;
}

}  // namespace mset::port::video

MSET_COV_ENTRY(e_av_guess_format_0054ba10, "0054ba10", "av_guess_format", ::mset::cov::Impl::ThirdPartyEquivalent, mset::port::video::guess_format)
MSET_COV_ENTRY(e_avformat_alloc_0054b9f8, "0054b9f8", "avformat_alloc_output_context2", ::mset::cov::Impl::ThirdPartyEquivalent, mset::port::video::alloc_output_context2)
MSET_COV_ENTRY(e_avio_open_0054b9d0, "0054b9d0", "avio_open", ::mset::cov::Impl::ThirdPartyEquivalent, mset::port::video::io_open)
MSET_COV_ENTRY(e_avio_close_0054b9d8, "0054b9d8", "avio_close", ::mset::cov::Impl::ThirdPartyEquivalent, mset::port::video::io_close)
