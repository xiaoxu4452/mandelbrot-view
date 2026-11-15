#include "port.hpp"

#include <algorithm>
#include <deque>
#include <string>
#include <vector>

namespace mset::cov {

const char* impl_name(Impl impl) {
    switch (impl) {
        case Impl::CoreAlgorithm: return "algorithm-core";
        case Impl::Application: return "application";
        case Impl::ThirdPartyEquivalent: return "thirdparty-equivalent";
    }
    return "unknown";
}

namespace {
std::vector<Entry>& table() {
    static std::vector<Entry> rows;
    return rows;
}
}  // namespace

void add(const Entry& entry) { table().push_back(entry); }

const Entry* begin() { return table().data(); }
const Entry* end() { return table().data() + table().size(); }
std::size_t size() { return table().size(); }

const char* rel_file(const char* compiler_file) {
    // __FILE__ arrives as an absolute path with backslashes under MSVC.  Trim
    // to the project-relative part so the coverage CSV is portable, and keep
    // the storage stable (deque never invalidates element references).
    static std::deque<std::string> pool;
    std::string s(compiler_file ? compiler_file : "");
    std::replace(s.begin(), s.end(), '\\', '/');
    for (const char* root : {"src/", "tests/", "tools/"}) {
        std::size_t pos = s.find(root);
        if (pos != std::string::npos) {
            s = s.substr(pos);
            break;
        }
    }
    pool.push_back(s);
    return pool.back().c_str();
}

}  // namespace mset::cov
