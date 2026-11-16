// FFmpeg / turbojpeg equivalent layer.
//
// The original exports its animations through libavformat/libavcodec/libavutil
// and its auxiliary stills through libturbojpeg.  This layer rebuilds the
// used subset: an AVIOContext over a real file handle, format/codec context
// objects, frame and packet buffers, a time-base rescaler, and a muxer that
// writes a valid AVI (video stream, MJPEG frames) plus an MJPEG frame writer.
// JPEG encode/decode is implemented here from the DCT/quantisation tables,
// not delegated to a system codec.
//
// Register every row with MSET_COV_ENTRY.

#pragma once

#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <map>
#include <string>
#include <vector>

namespace mset::port::video {

// --- reference / emulated constants ----------------------------------------
// Pixel formats (subset of AVPixelFormat the call sites use).
constexpr int kPixFmtNone = -1;
constexpr int kPixFmtRgb24 = 0;
constexpr int kPixFmtYuv420P = 1;

// Codec ids (subset of AVCodecID; the exported stream is MJPEG).
constexpr int kCodecIdNone = 0;
constexpr int kCodecIdMjpeg = 7;  // AV_CODEC_ID_MJPEG

// turbojpeg pixel formats (subset of TJPF).
constexpr int kTjpfRgb = 0;
constexpr int kTjpfBgr = 1;
constexpr int kTjpfRgba = 2;
constexpr int kTjpfBgra = 3;

// AVERROR-style negative codes, matching the libav convention used by the
// original call sites (negative return = error, -EAGAIN = no packet yet).
constexpr int kAverrorEagain = -11;
constexpr int kAverrorEnoent = -2;
constexpr int kAverrorEnomem = -12;
constexpr int kAverrorEinval = -22;

struct Packet {
    std::vector<std::uint8_t> data;
    int size = 0;
    long long pts = 0;
    long long dts = 0;
    bool key = false;
    bool initialized = false;
};

struct Frame {
    int width = 0;
    int height = 0;
    int format = kPixFmtRgb24;
    bool writable = false;
    std::vector<std::uint8_t> planar;  // Y, then U, then V or packed RGB
    int linesize[3] = {0, 0, 0};
};

struct Rational {
    int num = 1;
    int den = 1;
};

struct Codec {
    const char* name = "";
    int id = 0;
    int type = 0;   // 0 = video
};

struct CodecContext {
    const Codec* codec = nullptr;
    int codec_id = kCodecIdNone;
    int width = 0;
    int height = 0;
    int pix_fmt = kPixFmtNone;
    Rational time_base{1, 25};
    Rational framerate{25, 1};
    long long bit_rate = 0;
    int gop_size = 12;
    int quality = 75;

    // Real option dictionary (av_opt_set / av_opt_set_double).
    std::map<std::string, std::string> opt_str;
    std::map<std::string, double> opt_dbl;

    // Encoder state machine: idle -> have_frame -> packet produced -> idle.
    enum class State { Idle, Opened, HaveFrame, Flushed };
    State state = State::Idle;
    Frame pending;
    Packet produced;
    std::string error;
};

struct Stream {
    int index = 0;
    CodecContext* codec = nullptr;
    Rational time_base{1, 1000};
    int codec_id = kCodecIdNone;
    int width = 0;
    int height = 0;
    int pix_fmt = kPixFmtNone;
    long long bit_rate = 0;
    int quality = 75;
};

struct IOContext {
    std::string path;
    FILE* file = nullptr;
    bool writable = false;
    long long bytes_written = 0;
    long long bytes_read = 0;
};

struct Format {
    const char* name = "";
    const char* long_name = "";
    const char* default_extension = "";
    int flags = 0;
};

// One movi chunk recorded for the AVI idx1 index.
struct FrameRecord {
    long long offset = 0;  // file offset of the chunk data payload
    int size = 0;
    long long pts = 0;
};

struct FormatContext {
    const Format* oformat = nullptr;
    IOContext* pb = nullptr;
    std::vector<Stream*> streams;
    long long duration = 0;
    bool header_written = false;
    bool trailer_written = false;

    // AVI muxer bookkeeping.
    int frame_count = 0;
    Rational avg_frame_rate{25, 1};
    std::vector<FrameRecord> records;
    long long movi_list_offset = 0;  // offset of the "movi" LIST size field
    long long movi_payload_start = 0;
    int width = 0;
    int height = 0;
    int quality = 75;
    std::string error;
};

// --- format / IO ---------------------------------------------------------
const Format* guess_format(const char* short_name, const char* filename,
                           const char* mime_type);
FormatContext* alloc_output_context2(const Format* format, const char* filename);
int io_open(IOContext** pb, const char* path, int flags);
int io_close(IOContext* pb);
int write_header(FormatContext* ctx);
int write_trailer(FormatContext* ctx);
Stream* new_stream(FormatContext* ctx);
int free_format_context(FormatContext* ctx);
int interleaved_write_frame(FormatContext* ctx, Packet* pkt);

// --- codec --------------------------------------------------------------
const Codec* find_encoder(int id);
CodecContext* alloc_context3(const Codec* codec);
int open2(CodecContext* ctx, const Codec* codec, void* options);
void free_context(CodecContext* ctx);
int parameters_to_context(CodecContext* ctx, const Stream* stream);
int parameters_from_context(Stream* stream, const CodecContext* ctx);
void register_all();

// --- frame / packet ------------------------------------------------------
Frame* frame_alloc();
void frame_free(Frame** frame);
int frame_get_buffer(Frame* frame, int align);
int frame_make_writable(Frame* frame);
void init_packet(Packet* pkt);
void packet_unref(Packet* pkt);
int send_frame(CodecContext* ctx, const Frame* frame);
int receive_packet(CodecContext* ctx, Packet* pkt);
long long rescale_q(long long value, Rational from, Rational to);

// --- options dictionary ----------------------------------------------------
int opt_set(CodecContext* ctx, const char* name, const char* value);
int opt_set_double(CodecContext* ctx, const char* name, double value);

// --- turbojpeg equivalent -------------------------------------------------
struct TjHandle {
    bool compress = false;
    int width = 0;
    int height = 0;
    int quality = 75;
    int subsamp = 0;  // 0 = 4:2:0, 2 = 4:4:4
    std::vector<std::uint8_t> buffer;
    std::string error;
};

TjHandle* tj_init_compress();
TjHandle* tj_init_decompress();
const char* tj_get_error_str2(TjHandle* handle);
void tj_free(void* buffer);
void tj_destroy(TjHandle* handle);
int tj_decompress_header2(TjHandle* handle, const std::uint8_t* jpeg, int size,
                          int* width, int* height, int* subsamp);
int tj_decompress2(TjHandle* handle, const std::uint8_t* jpeg, int size,
                    std::uint8_t* out, int width, int pitch, int height,
                    int pixel_format);
int tj_compress2(TjHandle* handle, const std::uint8_t* src, int width, int pitch,
                 int height, int pixel_format, std::uint8_t** jpeg, int* jpeg_size,
                 int subsamp, int quality);

// Baseline JPEG codec used by the turbojpeg faces above.
bool jpeg_encode(const std::uint8_t* rgb, int width, int height, int quality,
                 int subsamp, std::vector<std::uint8_t>* out, std::string* error);
bool jpeg_decode(const std::uint8_t* data, std::size_t size, int* width, int* height,
                 int* subsamp, std::vector<std::uint8_t>* rgb, std::string* error);

// --- AVI parser used by the behavioural tests -----------------------------
struct AviInfo {
    bool ok = false;
    char fourcc[5] = {0, 0, 0, 0, 0};
    int width = 0;
    int height = 0;
    int stream_count = 0;
    int frame_count = 0;
    long long file_size = 0;
};

// Parse the AVI written by this muxer: verify RIFF/AVI fourcc, hdrl stream
// header ('vids'), BITMAPINFOHEADER dimensions and count the '00dc' movi
// chunks.  Returns false (and fills *error) on a truncated/garbled file.
bool parse_avi(const char* path, AviInfo* out, std::string* error);

}  // namespace mset::port::video
