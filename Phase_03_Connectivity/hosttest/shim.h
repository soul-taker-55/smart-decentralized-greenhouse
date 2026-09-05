#pragma once
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cstdarg>
#include <cctype>
#include "hostsha.h"
struct { void printf(const char* f, ...) { va_list a; va_start(a,f); vprintf(f,a); va_end(a);} } Serial;
inline void mbedtls_sha256(const unsigned char* d, size_t n, unsigned char out[32], int) { host_sha256(d, n, out); }
