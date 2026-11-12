#include <boost/multiprecision/cpp_bin_float.hpp>
#include <boost/multiprecision/number.hpp>
#include <boost/multiprecision/detail/default_ops.hpp>
using namespace boost::multiprecision;
int main() {
  number<cpp_bin_float<100> > x("0.1234567890123456789012345678901234567890");
  x *= x; x += 1;
  return x.convert_to<double>() > 0 ? 0 : 1;
}
