#include "bigfloat.hpp"
#include "floatexp.hpp"
#include "image.hpp"
#include "palette.hpp"
#include "mathx/expr.hpp"
#include "mathx/families.hpp"
#include "port/port.hpp"
#include "dive.hpp"
#include "gmp_bridge.hpp"
#include "reference.hpp"
#include "workspace.hpp"
#include "render.hpp"

#include <chrono>
#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

namespace {

void usage() {
    std::cout <<
        "mset — scientific Mandelbrot engine (Retinamandelbrot reconstruction)\n"
        "\n"
        "Usage:\n"
        "  mset render [options]\n"
        "  mset probe  [--digits N] [--iter N]\n"
        "  mset plan   [--zoom 1eN]\n"
        "  mset coverage [--dump|--check]\n"
        "  mset nucleus --center-re D --center-im D [--period N] [--digits N]\n"
        "  mset misiurewicz --m M --p P [--center-re D --center-im D] [--digits N]\n"
        "  mset family --kind tricorn|burningship|celtic|perpendicular|phoenix|formula\n"
        "              [--expr \"sin(z)^2 + c\"] [--zoom 1e120] [--out PNG]\n"
        "  mset family-point --kind tricorn --preperiod 3 --period 1 --digits 200\n"
        "  mset info\n"
        "\n"
        "Render options:\n"
        "  --config FILE       load a workspace JSON (later options override)\n"
        "  --center-re D       real part of centre (decimal string, default -0.6)\n"
        "  --center-im D       imaginary part (default 0)\n"
        "  --zoom D            magnification, e.g. 1e6, 1e800000 (default 1)\n"
        "  --width N           image width (default 800)\n"
        "  --height N          image height (default 600)\n"
        "  --maxiter N         iteration limit (default 2000)\n"
        "  --precision N       decimal digits (default: ceil(log10 zoom)+50)\n"
        "  --max-precision N   safety cap (default 1200000)\n"
        "  --palette NAME      rainbow|nebula|fire|ocean|mono|rainbow2\n"
        "  --color MODE        smooth|iteration|distance|binary\n"
        "  --span D            complex-plane width at zoom=1 (default 3)\n"
        "  --threads N         worker threads (default: hardware concurrency)\n"
        "  --tile N            tile size (default 64)\n"
        "  --sa-order N        series approximation order, 0 disables (default 8)\n"
        "  --no-sa             disable series approximation\n"
        "  --distance          compute distance-estimator channel\n"
        "  --palette-scale D   palette multiplier, 0 = auto by zoom (default 0)\n"
        "  --distance-param D  distance scheme param[0] (default 0)\n"
        "  --exact             direct BigFloat iteration per pixel (validation)\n"
        "  --no-tile-rebase    disable local reference retry for glitched tiles\n"
        "  --julia             render a Julia set (z0 = pixel, c fixed)\n"
        "  --julia-re D        fixed c real part for --julia\n"
        "  --julia-im D        fixed c imaginary part for --julia\n"
        "  --interior-color    colour interior points instead of black\n"
        "\n"
        "Nucleus options (Newton zoom):\n"
        "  --center-re D       starting point (required)\n"
        "  --center-im D       starting point imaginary part\n"
        "  --period N          minibrot period; 0 = detect from atom domain\n"
        "  --digits N          significant digits of the output coordinate\n"
        "  --maxiter N         atom-domain search length (default 100000)\n"
        "  --newton N          maximum Newton steps (default 12)\n"
        "  --m / --p           Misiurewicz preperiod and period (default 2/2)\n"
        "  --invert            invert colours\n"
        "  --out FILE          output .png or .ppm\n"
        "\n"
        "Examples:\n"
        "  mset render --center-re -0.7436438870371587 --center-im 0.1318259042053119 \\\n"
        "              --zoom 1e12 --width 800 --height 600 --maxiter 5000 --out deep.png\n"
        "  mset probe --digits 800000 --iter 12\n";
}

std::string arg_value(int argc, char** argv, int& i) {
    if (i + 1 >= argc) return std::string();
    return argv[++i];
}

bool parse_zoom(const std::string& text, double& mant, int64_t& exp10) {
    std::string s = text;
    size_t ep = s.find_first_of("eE");
    if (ep == std::string::npos) {
        char* end = nullptr;
        double v = std::strtod(s.c_str(), &end);
        if (end == s.c_str() || *end != 0 || !(v > 0)) return false;
        mant = 1.0;
        exp10 = 0;
        // normalize v into mant * 10^exp
        int e = (int)std::floor(std::log10(v));
        mant = v / std::pow(10.0, e);
        exp10 = e;
        return true;
    }
    std::string mpart = s.substr(0, ep);
    std::string epart = s.substr(ep + 1);
    char* end = nullptr;
    double m = std::strtod(mpart.c_str(), &end);
    if (end == mpart.c_str() || *end != 0 || !(m > 0)) return false;
    char* eend = nullptr;
    long long ev = std::strtoll(epart.c_str(), &eend, 10);
    if (eend == epart.c_str() || *eend != 0) return false;
    mant = m;
    exp10 = ev;
    return true;
}

int cmd_probe(int argc, char** argv) {
    int digits = 800000;
    int iterations = 8;
    for (int i = 2; i < argc; ++i) {
        std::string a = argv[i];
        if (a == "--digits") digits = std::atoi(arg_value(argc, argv, i).c_str());
        else if (a == "--iter") iterations = std::atoi(arg_value(argc, argv, i).c_str());
        else if (a == "-h" || a == "--help") { usage(); return 0; }
    }
    if (digits < 100) digits = 100;
    if (iterations < 1) iterations = 1;

    int limbs = digits / 9 + 4;
    BigFloat::precision_limbs = limbs;

    // Build a centre with `digits` significant digits: -0.7436438870371587...
    std::string frac = "743643887037158704752191506114774";
    while ((int)frac.size() < digits - 2) {
        static const char* pat = "982451653092186117073";
        frac += pat;
    }
    frac.resize((size_t)digits - 2);
    BigFloat c = BigFloat::from_string("-0." + frac);
    BigFloat tiny = BigFloat::from_string("1e-" + std::to_string(digits));

    std::cout << "precision: " << digits << " decimal digits (" << limbs << " limbs, "
              << (int64_t)limbs * 9 << " stored digits)\n";

    auto t0 = std::chrono::steady_clock::now();
    BigFloat c2 = c + tiny;
    BigFloat diff = c2 - c;
    auto t1 = std::chrono::steady_clock::now();
    std::cout << "add/sub at depth: " << std::chrono::duration<double>(t1 - t0).count()
              << " s;  delta = " << diff.to_scientific(12) << "\n";

    BigFloat zr(0.0), zi(0.0);
    t0 = std::chrono::steady_clock::now();
    for (int n = 0; n < iterations; ++n) {
        BigFloat sum = zr + zi;
        BigFloat dif = zr - zi;
        BigFloat re2 = sum * dif;
        BigFloat im2 = (zr * zi).mul_ui(2);
        zr = re2 + c;
        zi = im2;
    }
    t1 = std::chrono::steady_clock::now();
    double secs = std::chrono::duration<double>(t1 - t0).count();
    std::cout << "orbit: " << iterations << " iterations in " << secs << " s ("
              << (secs / iterations) << " s/iter)\n";
    std::cout << "z_" << iterations << " = " << zr.to_scientific(20);
    if (!zi.is_zero()) std::cout << " + " << zi.to_scientific(20) << "i";
    std::cout << "\n";
    std::cout << "|z| ~ 10^" << zr.magnitude_exp10() << "\n";
    return 0;
}

std::string fexp_str(const Fexp& f, int digits = 17) {
    if (f.m == 0.0) return "0";
    char buf[64];
    std::snprintf(buf, sizeof(buf), "%.*g", digits, f.m);
    std::string s(buf);
    s += "e";
    s += std::to_string(f.e);
    return s;
}

int cmd_orbit(int argc, char** argv) {
    std::string cre = "-0.6", cim = "0";
    int iterations = 16;
    int digits = 60;
    for (int i = 2; i < argc; ++i) {
        std::string a = argv[i];
        if (a == "--center-re") cre = arg_value(argc, argv, i);
        else if (a == "--center-im") cim = arg_value(argc, argv, i);
        else if (a == "--iter") iterations = std::atoi(arg_value(argc, argv, i).c_str());
        else if (a == "--digits") digits = std::atoi(arg_value(argc, argv, i).c_str());
    }
    BigFloat::precision_limbs = std::max(8, digits / 9 + 4);
    BigFloat cr = BigFloat::from_string(cre);
    BigFloat ci = BigFloat::from_string(cim);
    Orbit o;
    o.digits = digits;
    std::string err;
    Fexp dm(1e-12, 0);
    if (!compute_orbit(o, cr, ci, iterations, false, 0, dm, &err)) {
        std::cerr << "orbit failed: " << err << "\n";
        return 1;
    }
    std::cout << "orbit for c = " << cre << " + " << cim << "i\n";
    for (size_t n = 0; n < o.z.size(); ++n) {
        std::cout << "z[" << n << "] = " << fexp_str(o.z[n].re, 17) << " + "
                  << fexp_str(o.z[n].im, 17) << "i\n";
    }
    if (o.escaped) std::cout << "escaped at " << o.escape_iter << "\n";
    return 0;
}

int cmd_plan(int argc, char** argv) {
    std::string zoom_text = "1e12";
    for (int i = 2; i < argc; ++i) {
        std::string a = argv[i];
        if (a == "--zoom") zoom_text = arg_value(argc, argv, i);
    }
    double mant = 1.0;
    int64_t e = 0;
    if (!parse_zoom(zoom_text, mant, e)) {
        std::cerr << "bad --zoom\n";
        return 2;
    }
    PrecisionPlan p = plan_precision(mant, e, 0, 1200000);
    std::cout << "zoom = " << mant << " x 10^" << e << "\n";
    std::cout << "precision = " << p.digits << " decimal digits, " << p.limbs << " limbs\n";
    std::cout << "pixel scale needs about 10^-" << (e + 1) << " resolution\n";
    return 0;
}

int cmd_render(int argc, char** argv) {
    RenderRequest req;
    std::string out_path;

    for (int i = 2; i < argc; ++i) {
        std::string a = argv[i];
        if (a == "--center-re") req.center_re = arg_value(argc, argv, i);
        else if (a == "--center-im") req.center_im = arg_value(argc, argv, i);
        else if (a == "--zoom") {
            std::string v = arg_value(argc, argv, i);
            if (!parse_zoom(v, req.zoom_mantissa, req.zoom_exp10)) {
                std::cerr << "bad --zoom: " << v << "\n";
                return 2;
            }
        } else if (a == "--width") req.width = std::atoi(arg_value(argc, argv, i).c_str());
        else if (a == "--height") req.height = std::atoi(arg_value(argc, argv, i).c_str());
        else if (a == "--maxiter") req.maxiter = std::atoi(arg_value(argc, argv, i).c_str());
        else if (a == "--precision") req.precision_digits = std::atoi(arg_value(argc, argv, i).c_str());
        else if (a == "--max-precision") req.max_precision_digits = std::atoi(arg_value(argc, argv, i).c_str());
        else if (a == "--threads") req.threads = std::atoi(arg_value(argc, argv, i).c_str());
        else if (a == "--tile") req.tile_size = std::atoi(arg_value(argc, argv, i).c_str());
        else if (a == "--sa-order") req.sa_order = std::atoi(arg_value(argc, argv, i).c_str());
        else if (a == "--no-sa") req.use_sa = false;
        else if (a == "--distance") { req.use_distance = true; req.color_mode = ColorMode::Distance; }
        else if (a == "--exact") req.exact = true;
        else if (a == "--no-tile-rebase") req.tile_rebase = false;
        else if (a == "--tile-rebase") req.tile_rebase = true;
        else if (a == "--invert") req.invert = true;
        else if (a == "--palette") req.palette = arg_value(argc, argv, i);
        else if (a == "--palette-scale") req.palette_scale = std::atof(arg_value(argc, argv, i).c_str());
        else if (a == "--distance-param") req.distance_param = std::atof(arg_value(argc, argv, i).c_str());
        else if (a == "--span") req.span = std::atof(arg_value(argc, argv, i).c_str());
        else if (a == "--color") {
            std::string m = arg_value(argc, argv, i);
            if (m == "smooth") req.color_mode = ColorMode::Smooth;
            else if (m == "iteration") req.color_mode = ColorMode::Iteration;
            else if (m == "distance") req.color_mode = ColorMode::Distance;
            else if (m == "binary") req.color_mode = ColorMode::Binary;
            else { std::cerr << "unknown --color " << m << "\n"; return 2; }
        } else if (a == "--config") {
            std::string cfg = arg_value(argc, argv, i);
            std::string cfg_err;
            if (!load_workspace(cfg, req, &cfg_err)) {
                std::cerr << "config: " << cfg_err << "\n";
                return 2;
            }
        } else if (a == "--julia") req.julia = true;
        else if (a == "--julia-re") req.julia_re = arg_value(argc, argv, i);
        else if (a == "--julia-im") req.julia_im = arg_value(argc, argv, i);
        else if (a == "--interior-color") req.interior_palette = true;
        else if (a == "--out") out_path = arg_value(argc, argv, i);
        else if (a == "-h" || a == "--help") { usage(); return 0; }
        else { std::cerr << "unknown option: " << a << "\n"; return 2; }
    }

    if (req.maxiter < 1) req.maxiter = 1;
    if (out_path.empty()) out_path = "mandelbrot.png";

    Image img;
    RenderStats st;
    std::string err;
    if (!render_image(req, img, st, &err)) {
        std::cerr << "render failed: " << err << "\n";
        return 1;
    }

    bool png = true;
    if (out_path.size() >= 4) {
        std::string ext = out_path.substr(out_path.size() - 4);
        if (ext == ".ppm") png = false;
    }
    if (png) {
        if (!write_png(out_path, img, &err)) { std::cerr << err << "\n"; return 1; }
    } else {
        if (!write_ppm(out_path, img, &err)) { std::cerr << err << "\n"; return 1; }
    }

    std::cout << "rendered " << req.width << "x" << req.height
              << " in " << st.seconds << " s\n";
    std::cout << "  zoom = " << req.zoom_mantissa << "e" << req.zoom_exp10
              << "  precision = " << st.precision_digits << " digits\n";
    std::cout << "  reference orbit = " << st.reference_length << " points\n";
    std::cout << "  escape range = " << st.min_escape_iter << " .. "
              << st.max_escape_iter << "  interior = " << st.bounded
              << "  band = " << st.band_iters << " iters\n";
    std::cout << "  perturbation steps = " << st.steps
              << "  (" << (st.steps ? st.seconds * 1e9 / (double)st.steps : 0.0)
              << " ns/step, all threads)\n";
    std::cout << "  SA skipped iterations = " << st.sa_skipped_iters
              << "  glitches = " << st.glitches
              << "  local references = " << st.tile_references << "\n";
    std::cout << "  output: " << out_path << "\n";
    return 0;
}

std::string csv_field(const char* text) {
    std::string s = text ? text : "";
    bool needs_quotes = s.find_first_of(",\"\n") != std::string::npos;
    if (!needs_quotes) return s;
    std::string out = "\"";
    for (char c : s) {
        if (c == '"') out += "\"\"";
        else out += c;
    }
    out += "\"";
    return out;
}

// Address -> symbol table of the port layer.  --dump prints CSV for
// tools/coverage_report.py; --check exits non-zero on duplicate addresses or
// empty fields, i.e. on any row that has no compiled C++ home.
int cmd_coverage(int argc, char** argv) {
    bool check = false;
    for (int i = 2; i < argc; ++i) {
        std::string a = argv[i];
        if (a == "--check") check = true;
        else if (a == "--dump") check = false;
        else if (a == "-h" || a == "--help") { usage(); return 0; }
        else { std::cerr << "unknown coverage option: " << a << "\n"; return 2; }
    }

    std::vector<const mset::cov::Entry*> rows;
    for (const mset::cov::Entry* it = mset::cov::begin(); it != mset::cov::end(); ++it) {
        rows.push_back(it);
    }
    std::sort(rows.begin(), rows.end(), [](const mset::cov::Entry* a, const mset::cov::Entry* b) {
        return std::strcmp(a->address, b->address) < 0;
    });

    int problems = 0;
    for (std::size_t i = 0; i < rows.size(); ++i) {
        const mset::cov::Entry* e = rows[i];
        if (!e->address || !*e->address || !e->function || !*e->function || !e->symbol ||
            !*e->symbol || !e->file || !*e->file) {
            ++problems;
            std::cerr << "registry: empty field at row " << i << "\n";
        }
        if (i > 0 && std::strcmp(rows[i - 1]->address, e->address) == 0) {
            ++problems;
            std::cerr << "registry: duplicate address " << e->address << "\n";
        }
    }

    if (check) {
        int by_class[3] = {0, 0, 0};
        for (const mset::cov::Entry* e : rows) {
            by_class[static_cast<int>(e->impl)] += 1;
        }
        std::cout << "entries: " << rows.size() << "\n";
        std::cout << "  algorithm-core: " << by_class[0] << "\n";
        std::cout << "  application: " << by_class[1] << "\n";
        std::cout << "  thirdparty-equivalent: " << by_class[2] << "\n";
        std::cout << "registry problems: " << problems << "\n";
        return problems == 0 ? 0 : 1;
    }

    std::cout << "address,function,symbol,file,impl_class\n";
    for (const mset::cov::Entry* e : rows) {
        std::cout << csv_field(e->address) << "," << csv_field(e->function) << ","
                  << csv_field(e->symbol) << "," << csv_field(e->file) << ","
                  << mset::cov::impl_name(e->impl) << "\n";
    }
    if (problems != 0) {
        std::cerr << "registry problems: " << problems << "\n";
        return 1;
    }
    return 0;
}

int cmd_info() {
    unsigned hw = std::thread::hardware_concurrency();
    std::cout << "mset - deep-zoom Mandelbrot engine (perturbation core)\n"
              << "  version     0.9   (2026-11-14)\n"
#if defined(__AVX2__)
              << "  kernel      AVX2, four pixels per step (double path)\n"
#else
              << "  kernel      scalar\n"
#endif
              << "  threads     " << (hw ? hw : 1) << " hardware\n"
              << "  precision   GMP mpf reference orbit, width = zoom digits + 50 guard\n"
              << "              digits; built-in base-10^9 BigFloat is the fallback\n"
              << "  arithmetic  floatexp per pixel (double mantissa, int64 exponent),\n"
              << "              plain double above 1e-250 where the exponent cannot overflow\n"
              << "  method      reference orbit + normalized perturbation + series\n"
              << "              approximation, parallel multi-candidate references,\n"
              << "              cancellation detection and local-reference repair\n"
              << "  period      exact eventual-period detection in the first 64 mpf steps;\n"
              << "              a periodic reference's tail is tiled analytically, so a\n"
              << "              Misiurewicz view needs no full-precision squaring at all\n"
              << "  nucleus     `mset nucleus` (Newton on z_p(c)=0) and\n"
              << "              `mset misiurewicz` (Newton on z_{m+p}-z_m=0) produce\n"
              << "              deep coordinates at arbitrary digits\n"
              << "  output      PNG / PPM\n"
              << "\n"
              << "Verified (PNG comparisons byte-identical unless stated):\n"
              << "  1.54e73  deepest shipped example (Retinamandelbrot 14), 640x400 0.47 s\n"
              << "  1e38     vs exact BigFloat oracle (cmp 38 3000 5): 100% identical\n"
              << "  1e20     100% identical; 1e6 98.71% (chaotic boundary +-1 iteration)\n"
              << "  Julia    1e6/1e12/1e20/1e38 vs --exact: 0 differing pixels\n"
              << "  1e6000   c=i, 320x200, maxiter 30000: 0.084 s, esc 15946..15982\n"
              << "  1e60000  c=i, 160x100, maxiter 200000: 0.65 s, esc 159453..159488\n"
              << "           (periodic-orbit reuse; previously >20 minutes, no frame)\n"
              << "\n"
              << "Reference orbit backend: " << orbit_backend_name()
              << (gmpb::available() ? std::string(" (libgmp ") + gmpb::version() + ")" : "")
              << "\n"
              << "  Both backends agree to one ulp of a double mantissa (gmporbit).\n"
              << "  At 6000 digits GMP costs ~22 us/step against 1.3 ms for BigFloat.\n"
              << "  The series is replayed over the stored z_n rather than rebuilding\n"
              << "  the orbit, so a frame needs one high-precision orbit, not two.\n"
              << "\n"
              << "FFT question: gmpbench measures 22/43/106/463/980 us per step at\n"
              << "  6000/12000/24000/60000/120000 digits.  No FFT threshold is crossed;\n"
              << "  GMP 6.3 stays in Toom-Cook because it is FASTER there.  The 10^60000\n"
              << "  wall was the NUMBER of full-precision steps, not the multiply algorithm.\n"
              << "\n"
              << "Known limits: periodic reuse is exact only for analytically periodic\n"
              << "  centres (c=i, c=-2).  Newton-refined Misiurewicz coordinates carry a\n"
              << "  residual; MB_QUASI=1 relaxes the test to CFexp precision but is off by\n"
              << "  default because a merely near-periodic c has a divergent true orbit.\n"
              << "  Recursive Newton diving from 1e73 to 1e6000 is not implemented.\n";
    return 0;
}

int cmd_nucleus(int argc, char** argv) {
    std::string cre = "-0.6", cim = "0";
    int period = 0, digits = 200, maxiter = 100000, newton = 12;
    for (int i = 2; i < argc; ++i) {
        std::string a = argv[i];
        if (a == "--center-re") cre = arg_value(argc, argv, i);
        else if (a == "--center-im") cim = arg_value(argc, argv, i);
        else if (a == "--period") period = std::atoi(arg_value(argc, argv, i).c_str());
        else if (a == "--digits") digits = std::atoi(arg_value(argc, argv, i).c_str());
        else if (a == "--maxiter") maxiter = std::atoi(arg_value(argc, argv, i).c_str());
        else if (a == "--newton") newton = std::atoi(arg_value(argc, argv, i).c_str());
    }
    if (digits < 60) digits = 60;
    const NucleusResult r = find_nucleus(cre, cim, period, digits, newton, maxiter);
    if (!r.ok) {
        std::cerr << "nucleus failed: " << r.error << "\n";
        return 1;
    }
    std::cout << "period " << r.period << "\n"
              << "re " << r.re << "\n"
              << "im " << r.im << "\n"
              << "newton_steps " << r.newton_steps << "\n"
              << "last_step_log10 " << r.last_step_log10 << "\n"
              << "log10_minibrot_size " << r.log10_size << "\n";
    return 0;
}

int cmd_misiurewicz(int argc, char** argv) {
    int m = 2, p = 2, digits = 200, newton = 12;
    std::string cre = "0.1", cim = "1.05";
    for (int i = 2; i < argc; ++i) {
        std::string a = argv[i];
        if (a == "--m") m = std::atoi(arg_value(argc, argv, i).c_str());
        else if (a == "--p") p = std::atoi(arg_value(argc, argv, i).c_str());
        else if (a == "--center-re") cre = arg_value(argc, argv, i);
        else if (a == "--center-im") cim = arg_value(argc, argv, i);
        else if (a == "--digits") digits = std::atoi(arg_value(argc, argv, i).c_str());
        else if (a == "--newton") newton = std::atoi(arg_value(argc, argv, i).c_str());
    }
    if (digits < 60) digits = 60;
    const MisiurewiczResult r = find_misiurewicz(m, p, cre, cim, digits, newton);
    if (!r.ok) {
        std::cerr << "misiurewicz failed: " << r.error << "\n";
        return 1;
    }
    std::cout << "preperiod " << r.m << "\n"
              << "period " << r.p << "\n"
              << "re " << r.re << "\n"
              << "im " << r.im << "\n"
              << "newton_steps " << r.newton_steps << "\n"
              << "last_step_log10 " << r.last_step_log10 << "\n"
              << "log10_residual " << r.log10_residual << "\n";
    return 0;
}


/* ------------------------------------------------------------------ family
 *
 * Deep rendering for the folded families and for user formulas.  This is the
 * command-line face of src/mathx: the same engine the desktop shell calls for
 * a tricorn/burning-ship/celtic/perpendicular/phoenix frame and for a typed
 * expression such as "sin(z)^2 + c".
 */
int cmd_family(int argc, char** argv) {
    std::string kindName = "tricorn";
    std::string expr;
    std::string cre = "-0.6", cim = "0", jre, jim;
    std::string outPath = "family.png";
    std::string palName = "rainbow";
    int mode = 0, width = 640, height = 400, maxiter = 2000, digits = 0, threads = 0;
    double zoomMant = 1.0, band = 64.0, rotDeg = 0.0;
    /* Any number of decimal digits: a phoenix p or a slider that is only 16
     * digits long is what caps a family view at about 1e16. */
    std::string phoenixP = "0.5667";
    std::string paramSpec;
    int64_t zoomExp = 0;

    auto parse_zoom = [](const std::string& t, double& m, int64_t& e) {
        size_t p = t.find_first_of("eE");
        if (p == std::string::npos) { m = std::atof(t.c_str()); e = 0; return; }
        m = std::atof(t.substr(0, p).c_str());
        e = std::atoll(t.substr(p + 1).c_str());
    };

    for (int i = 2; i < argc; ++i) {
        std::string a = argv[i];
        if (a == "--kind") kindName = arg_value(argc, argv, i);
        else if (a == "--expr") expr = arg_value(argc, argv, i);
        else if (a == "--mode") { std::string m = arg_value(argc, argv, i); mode = (m == "j" || m == "julia") ? 1 : 0; }
        else if (a == "--center-re") cre = arg_value(argc, argv, i);
        else if (a == "--center-im") cim = arg_value(argc, argv, i);
        else if (a == "--julia-re") jre = arg_value(argc, argv, i);
        else if (a == "--julia-im") jim = arg_value(argc, argv, i);
        else if (a == "--zoom") parse_zoom(arg_value(argc, argv, i), zoomMant, zoomExp);
        else if (a == "--width") width = std::atoi(arg_value(argc, argv, i).c_str());
        else if (a == "--height") height = std::atoi(arg_value(argc, argv, i).c_str());
        else if (a == "--maxiter") maxiter = std::atoi(arg_value(argc, argv, i).c_str());
        else if (a == "--digits") digits = std::atoi(arg_value(argc, argv, i).c_str());
        else if (a == "--threads") threads = std::atoi(arg_value(argc, argv, i).c_str());
        else if (a == "--phoenix") phoenixP = arg_value(argc, argv, i);
        else if (a == "--param") paramSpec += (paramSpec.empty() ? "" : ";") +
                                            arg_value(argc, argv, i);
        else if (a == "--band") band = std::atof(arg_value(argc, argv, i).c_str());
        else if (a == "--rotation") rotDeg = std::atof(arg_value(argc, argv, i).c_str());
        else if (a == "--palette") palName = arg_value(argc, argv, i);
        else if (a == "--out") outPath = arg_value(argc, argv, i);
        else if (a == "-h" || a == "--help") { usage(); return 0; }
        else { std::cerr << "unknown family option: " << a << "\n"; return 2; }
    }

    int kind = -1;
    if (kindName == "tricorn") kind = 1;
    else if (kindName == "burningship" || kindName == "burning-ship" || kindName == "burning") kind = 2;
    else if (kindName == "celtic") kind = 3;
    else if (kindName == "perpendicular") kind = 4;
    else if (kindName == "phoenix") kind = 5;
    else if (kindName == "formula" || kindName == "custom") kind = 6;
    if (kind < 0) { std::cerr << "unknown family: " << kindName << "\n"; return 2; }
    if (kind == 6 && expr.empty()) { std::cerr << "--expr is required for --kind formula\n"; return 2; }

    const double psLog10 = std::log10(3.0 / (zoomMant * width)) - (double)zoomExp;
    int wantDigits = digits;
    if (wantDigits <= 0) {
        wantDigits = (int)(-psLog10) + 40;
        if (wantDigits < 60) wantDigits = 60;
    }

    mx::Program program;
    if (kind == 6) {
        try {
            program = mx::compile(expr, wantDigits + 20);
        } catch (const mx::ExprError& e) {
            std::cerr << "formula error at " << e.pos << ": " << e.what() << "\n";
            return 2;
        }
    }

    mx::FamilyView v;
    v.kind = kind;
    v.mode = mode;
    v.formula = kind == 6 ? &program : nullptr;
    v.centerRe = cre;
    v.centerIm = cim;
    v.juliaRe = jre;
    v.juliaIm = jim;
    v.width = width;
    v.height = height;
    v.maxiter = maxiter;
    v.digits = wantDigits;
    v.ps = Fexp(3.0 / (zoomMant * width), -zoomExp);
    v.phoenixP = phoenixP;
    if (kind == 6 && !paramSpec.empty()) {
        /* "a=0.5;b=1" -> one BigFloat per program parameter, at the same
         * precision the orbit runs at. */
        v.params.assign(program.params.size(), BigFloat());
        size_t at = 0;
        while (at < paramSpec.size()) {
            size_t semi = paramSpec.find(';', at);
            if (semi == std::string::npos) semi = paramSpec.size();
            const std::string kv = paramSpec.substr(at, semi - at);
            at = semi + 1;
            const size_t eq = kv.find('=');
            if (eq == std::string::npos) continue;
            const std::string name = kv.substr(0, eq);
            for (size_t pi = 0; pi < program.params.size(); ++pi) {
                if (program.params[pi] == name)
                    v.params[pi] = BigFloat::from_string(kv.substr(eq + 1));
            }
        }
    }
    v.threads = threads;
    v.rotCos = std::cos(rotDeg * 3.14159265358979323846 / 180.0);
    v.rotSin = std::sin(rotDeg * 3.14159265358979323846 / 180.0);

    std::vector<PixelOut> px;
    mx::FamilyStats st;
    if (!mx::renderFamily(v, px, &st)) {
        std::cerr << "family render failed: " << st.error << "\n";
        return 1;
    }

    const Palette pal = Palette::by_name(palName);
    Image img;
    img.resize(width, height);
    for (int y = 0; y < height; ++y) {
        for (int x = 0; x < width; ++x) {
            const PixelOut& p = px[(size_t)y * width + x];
            RGB c{0, 0, 0};
            if (!p.interior) {
                double t = p.smooth / (band > 1.0 ? band : 64.0) + 0.5;
                c = pal.eval(t);
                c.r = std::min(1.0, std::max(0.0, c.r));
                c.g = std::min(1.0, std::max(0.0, c.g));
                c.b = std::min(1.0, std::max(0.0, c.b));
            }
            uint8_t* q = img.pixel(x, y);
            q[0] = (uint8_t)(c.r * 255.0 + 0.5);
            q[1] = (uint8_t)(c.g * 255.0 + 0.5);
            q[2] = (uint8_t)(c.b * 255.0 + 0.5);
        }
    }
    std::string err;
    if (outPath.size() >= 4 && outPath.substr(outPath.size() - 4) == ".ppm") {
        if (!write_ppm(outPath, img, &err)) { std::cerr << err << "\n"; return 1; }
    } else if (!write_png(outPath, img, &err)) {
        std::cerr << err << "\n";
        return 1;
    }

    std::cout << "family " << mx::familyName(kind) << " " << width << "x" << height
              << " zoom=" << zoomMant << "e" << zoomExp << " digits=" << st.digits << "\n";
    std::cout << "  reference orbits = " << st.refs << "  longest = " << st.refLen
              << " points  glitches = " << st.glitches << "\n";
    std::cout << "  escape range = " << st.escMin << " .. " << st.escMax
              << "  interior = " << st.bounded << "  time = " << st.ms << " ms\n";
    std::cout << "  output: " << outPath << "\n";
    return 0;
}


/* ------------------------------------------------------------ family-point
 *
 * Find a nucleus (--preperiod 0) or a Misiurewicz point (--preperiod > 0) of a
 * folded family at arbitrary precision.  This is the coordinate generator that
 * makes a 1e120 frame meaningful: only a boundary point carries structure at
 * that scale, and a 120-digit boundary point cannot be typed by hand.
 */
int cmd_family_point(int argc, char** argv) {
    std::string kindName = "tricorn";
    std::string gre = "0", gim = "0";
    int preperiod = 0, period = 3, digits = 200, maxNewton = 24;
    std::string phoenixP = "0.5667";
    for (int i = 2; i < argc; ++i) {
        std::string a = argv[i];
        if (a == "--kind") kindName = arg_value(argc, argv, i);
        else if (a == "--preperiod" || a == "--m") preperiod = std::atoi(arg_value(argc, argv, i).c_str());
        else if (a == "--period" || a == "--p") period = std::atoi(arg_value(argc, argv, i).c_str());
        else if (a == "--digits") digits = std::atoi(arg_value(argc, argv, i).c_str());
        else if (a == "--guess-re") gre = arg_value(argc, argv, i);
        else if (a == "--guess-im") gim = arg_value(argc, argv, i);
        else if (a == "--max-newton") maxNewton = std::atoi(arg_value(argc, argv, i).c_str());
        else if (a == "--phoenix") phoenixP = arg_value(argc, argv, i);
        else if (a == "-h" || a == "--help") { usage(); return 0; }
        else { std::cerr << "unknown family-point option: " << a << "\n"; return 2; }
    }
    int kind = 0;
    if (kindName == "tricorn") kind = 1;
    else if (kindName == "burningship" || kindName == "burning-ship") kind = 2;
    else if (kindName == "celtic") kind = 3;
    else if (kindName == "perpendicular") kind = 4;
    else if (kindName == "phoenix") kind = 5;
    else { std::cerr << "unknown family: " << kindName << "\n"; return 2; }

    const mx::PointResult r = mx::findFamilyPoint(kind, phoenixP, preperiod, period, gre, gim,
                                                  digits, maxNewton);
    if (!r.ok) {
        std::cerr << "family-point failed: " << r.error << "\n";
        return 1;
    }
    std::cout << "kind " << kindName << "  preperiod " << preperiod << "  period " << period
              << "  digits " << digits << "\n";
    std::cout << "re " << r.re << "\n";
    std::cout << "im " << r.im << "\n";
    std::cout << "newton_steps " << r.newton_steps << "\n";
    std::cout << "log10_residual " << r.log10_residual << "\n";
    return 0;
}

}  // namespace

int main(int argc, char** argv) {
    if (argc < 2) { usage(); return 0; }
    std::string cmd = argv[1];
    if (cmd == "render") return cmd_render(argc, argv);
    if (cmd == "probe") return cmd_probe(argc, argv);
    if (cmd == "orbit") return cmd_orbit(argc, argv);
    if (cmd == "plan") return cmd_plan(argc, argv);
    if (cmd == "coverage") return cmd_coverage(argc, argv);
    if (cmd == "nucleus") return cmd_nucleus(argc, argv);
    if (cmd == "misiurewicz") return cmd_misiurewicz(argc, argv);
    if (cmd == "family") return cmd_family(argc, argv);
    if (cmd == "family-point") return cmd_family_point(argc, argv);
    if (cmd == "info") return cmd_info();
    if (cmd == "-h" || cmd == "--help" || cmd == "help") { usage(); return 0; }
    std::cerr << "unknown command: " << cmd << "\n";
    usage();
    return 2;
}
