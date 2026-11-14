package core

// X-Medusa（竞品 crypto.BuildMedusaFor 0x14068b640）的完整还原实现。
//
// 全部算法均以 Unicorn 模拟器直接执行竞品函数得到的输出为基准逐字节校验：
//   - aesV3 分组密码（newAesV3 + (*aesV3).block）：4 变体 × 6 向量全等
//   - (*aesV3).encrypt：648 字节输出全等
//   - keyHash / xmxor / Proto 组包：全等
//   - 整条流水线：header 24 字节 + 648 字节密文，与模拟器一致
//
// 结构：out = base64( head24 ‖ encrypt( hdr9 ‖ revxor(acc636) ‖ seedHi16 ) )
//   acc636   = 0x4001000000000000 ‖ xmxor(P4, keyHash(seed2))
//   head24   = head20(常量 ^ flag) ‖ LE16(seed2) ‖ 00 01
//   hdr9     = 35, seed3低字节, 00,00,00, LE32(((h0&63)<<14)|((h1&63)<<8)|0x18000001)

import (
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"math"
	"math/rand"
	"net/http"
	"time"
)

var (
	hgMedusaSignKeyBytes = hgMedusaUnhex("8ebdfa3806ecc5cee79423e6029ed82540bc2218bb7eaef71cb691f7aa8aa2f5")
	hgMedusaAESKeyBytes  = hgMedusaUnhex("f1593376766ea98d34f31b057a9d5be4")
	hgMedusaAESIVBytes   = hgMedusaUnhex("1fe109a4125283f418de9e051a969e12")
	hgMedusaP4F1         = hgMedusaUnhex("f7e85ffad7d7dc3bd62ac87057cf6118")
	hgMedusaP4F13        = hgMedusaUnhex("62387f6c97e2e1559371b9556baa9e1af6af830a")
	hgMedusaP4F14        = hgMedusaUnhex("1ab21d8355cf")
	hgMedusaP4F19        = hgMedusaUnhex("903f1c5f804e1c270b02f0bd60618653002521ded6d5049f49aa05e746be090b")
	hgMedusaHead20       = hgMedusaUnhex("050000002d4b4fca49750d433fb5ae2c226dcc56")
	hgMedusaAcc8         = hgMedusaUnhex("4001000000000000")
	hgMedusaSbox         = hgMedusaDecodeSbox("+n0Ia5xZs0sEXznQOEqRmQBnpiCf9U2Ccybu3xhmgzOAAxn72f6uqqmwUsYL83klTni0NqxdGieeiNu9PGPsSRXBMB/cuFbUbM3KCUPINaPvHvSW0vwOcnuUhNHqRVpiAj/TEoE0K91+5ijypUYTATsh9mE3KSoN7Yyvv51cuyR2D3XkU4nhmI2xmmVwT1RMWKtub4sjxAcRDLrPoKSO2AU9FLLadMPX577Wf95IFj6FkKFVt3dCIsmGUC4X+WQxLJvxbRxEaOPpqJOXyzJX6+Vxaq3AzMfF/WAdoi1Hp+JRaV56zgpBtpWP97mH4DoGEIq1+FvV8LyS/3wvwugbQOwb2r26mJEMsiuDQTRn+wrYdrVGBVlhI3WQhyrjUBVMrLF5667llUcEaPCGPVGLD8qO5LlO8hKCvA7V9+8oJc9bXelqVQLhM76T5/WtnT45JKji+hdX0HoNCDDWuKON/QeaxB5uImSX0h2wv0VmP2zd2yeApxHcpsVS+MC2yFwAc2B7oBkTqsk1SEvTpM2fmfMQREBUfin0Bh+iq6EvPPavhWI2IX9e3yAas7Tm/3KEj2UmlFp36kN4x0rMLBRrxuh0U/zUHM4xcAMYjJY4MonxOl/X+alpt2M3WMI7w3HLnpIBigtNiJu7T21v4P6lSd5WFgntnMEt7oF92XzRLkJbTcGmXepE/UVOG6E/0YnhfS+q26utWcuxzpooyeD2cDlK1/8w9d28VzsRjbLuALbmGlp8+d7EzS6Au7lMpZ+ECMZvQmzwJ+eLOpxR+2chdUExp8ogQyq3v9l68rX4jCwjg0+PYKAEEzcU4wHFY2ZcdIHfWL1okD3SszT0GZMyKdZJrg1L2AeerB4tC0C4crp2EHGo5FYdSP7lwkeR2ocmnR+Ia8CYviUJlzOjhRZef9xuVOn3qcjow3fQgivsAmKKkg4+sA8F8/GWeDiGNhg8JM8KtFPMYWWkx5TVFX5t73kiNRJqjlIGVXtGZFCV4gzt0xcDopuZ6xz8r9Rzafpf9ywev8jh8592gHFIqpStZPuJxmDDMrNN0uBE3V+oscdoIzTJbRJ/t+sVvqnReJOgDJKk10fjisJwqyZBmnmn2BSFj8BvVtCMEbkuPOKdzw7eA11GPs04Qw8zWtkaZWwiO/wwpojqN6K0jY5RnNZA7vn4hPSul+nKCkVnVwQvg1zVxcSCtqORmB9KrJaBbssbCQivGJVJfVTt+hYxOtq4ZvWl8f4QAQZ0zGPffCgl9s6yT4vlvIdpu4YhBwA25wtQWZsc6GJYGWHyvSdeuh3mmUI9DSq13Fsp8C1MU3tqc04/df9LoTUXVXI5INOw/e8C7Hd+5CvbkMEFnnrUUmskEw==")

	// hashF13 输出的低 6 位（h0 恒为 0x1a，h1 随 flag 变化）。
	hgMedusaH1ByFlag = [6]byte{0x22, 0x2b, 0x31, 0x1d, 0x1b, 0x27}
)

const (
	hgMedusaH0Mask  = 0x1a
	hgMedusaJSON24  = `{"cmr":16777216,"cmr2":16777216,"un_h":1879194040,"vpn":0,"kd":0,"fkd":3672518972,"pd":-1872573247,"dyn":"","do":0,"tk":true}`
	hgMedusaEnvTag6 = "v04.06.04.03-bugfix"
	hgMedusaDevTag8 = "v04.06.04-ml-android"
)

// hgMedusaDebug 用于对照模拟器基准做逐段回归（生产路径为 nil）。
var hgMedusaDebug func(stage string, data []byte)

func hgMedusaUnhex(text string) []byte {
	out, err := hex.DecodeString(text)
	if err != nil {
		panic("hongguo medusa: invalid constant " + text)
	}
	return out
}

func hgMedusaDecodeSbox(text string) []byte {
	out, err := base64.StdEncoding.DecodeString(text)
	if err != nil || len(out) != 1024 {
		panic("hongguo medusa: invalid aesV3 sbox")
	}
	return out
}

// ---- protobuf 手写编码（竞品 hg-go/pkg/crypto.Proto/ProtoField 的等价实现） ----

func hgMedusaVarint(value uint64) []byte {
	var out []byte
	for value >= 0x80 {
		out = append(out, byte(value)|0x80)
		value >>= 7
	}
	return append(out, byte(value))
}

func hgMedusaSint(num int, value int64) []byte {
	zig := uint64(value<<1) ^ uint64(value>>63)
	return append(hgMedusaVarint(uint64(num)<<3), hgMedusaVarint(zig)...)
}

func hgMedusaBlob(num int, body []byte) []byte {
	out := append(hgMedusaVarint(uint64(num)<<3|2), hgMedusaVarint(uint64(len(body)))...)
	return append(out, body...)
}

func hgMedusaString(num int, text string) []byte { return hgMedusaBlob(num, []byte(text)) }

func hgMedusaFloat(num int, value float32) []byte {
	out := hgMedusaVarint(uint64(num)<<3 | 5)
	return append(out, byte(math.Float32bits(value)), byte(math.Float32bits(value)>>8),
		byte(math.Float32bits(value)>>16), byte(math.Float32bits(value)>>24))
}

// ---- aesV3：竞品 crypto.newAesV3 + (*aesV3).block ----

type hgMedusaAes struct {
	variant int
	box     []byte
	t1      [4]int
	t2      [16]int
	keys    [3][16]byte
}

var (
	hgMedusaT1 = [4][4]int{{1, 0, 2, 3}, {2, 0, 3, 1}, {0, 1, 3, 2}, {1, 0, 2, 3}}
	hgMedusaT2 = [4][16]int{
		{0, 9, 14, 11, 4, 13, 2, 7, 8, 1, 6, 15, 12, 5, 10, 3},
		{0, 9, 14, 15, 4, 13, 2, 7, 8, 1, 6, 3, 12, 5, 10, 11},
		{0, 9, 14, 7, 4, 13, 2, 11, 8, 1, 6, 3, 12, 5, 10, 15},
		{0, 9, 14, 11, 4, 13, 2, 7, 8, 1, 6, 15, 12, 5, 10, 3},
	}
	hgMedusaCV = [4]uint32{0xca025ddc, 0x823dc546, 0xc9420583, 0xc298225f}
)

func newHgMedusaAes(key []byte, variant int) *hgMedusaAes {
	variant &= 3
	cv := hgMedusaCV[variant]
	box := hgMedusaSbox[variant*256 : (variant+1)*256]
	pre := make([]byte, 16)
	for i := 0; i < 16; i++ {
		pre[i] = key[i] ^ byte(cv>>(8*uint(i%4)))
	}
	cipher := &hgMedusaAes{variant: variant, box: box}
	cipher.t1 = hgMedusaT1[variant]
	cipher.t2 = hgMedusaT2[variant]
	var words [12][4]byte
	for i := 0; i < 4; i++ {
		for j := 0; j < 4; j++ {
			words[i][j] = pre[4*i+j]
		}
	}
	for i := 4; i < 12; i++ {
		prev := words[i-1]
		var temp [4]byte
		if i%4 == 0 {
			rcon := byte(cv >> (8 * uint(i/4)))
			temp = [4]byte{box[prev[1]] ^ rcon, box[prev[2]], box[prev[3]], box[prev[0]]}
		} else {
			temp = prev
		}
		for j := 0; j < 4; j++ {
			words[i][j] = words[i-4][j] ^ temp[j]
		}
	}
	for i := 0; i < 12; i++ {
		copy(cipher.keys[i/4][(i%4)*4:], words[i][:])
	}
	return cipher
}

func hgMedusaXtime(a byte) byte {
	out := a << 1
	if a&0x80 != 0 {
		out ^= 0x1b
	}
	return out
}

func (cipher *hgMedusaAes) mixColumn(a0, a1, a2, a3 byte) (byte, byte, byte, byte) {
	total := a0 ^ a1 ^ a2 ^ a3
	return a0 ^ total ^ hgMedusaXtime(a0^a1),
		a1 ^ total ^ hgMedusaXtime(a1^a2),
		a2 ^ total ^ hgMedusaXtime(a2^a3),
		a3 ^ total ^ hgMedusaXtime(a3^a0)
}

func (cipher *hgMedusaAes) block(src []byte) []byte {
	var s [16]byte
	copy(s[:], src)
	ark := func(round int, perm [4]int) {
		base := &cipher.keys[round]
		for i := 0; i < 4; i++ {
			for j := 0; j < 4; j++ {
				s[4*i+j] ^= base[4*i+perm[j]]
			}
		}
	}
	ark(0, cipher.t1)
	for round := 1; round <= 2; round++ {
		for x := 0; x < 16; x++ {
			s[x] = cipher.box[s[x]]
		}
		saved := s
		for i := 0; i < 4; i++ {
			for j := 0; j < 4; j++ {
				s[4*i+j] = saved[4*cipher.t1[i]+j]
			}
		}
		saved = s
		for x := 0; x < 16; x++ {
			s[x] = saved[cipher.t2[x]]
		}
		if round == 1 {
			saved = s
			for i := 0; i < 4; i++ {
				for j := 0; j < 4; j++ {
					s[4*i+j] = saved[4*i+cipher.t1[j]]
				}
			}
			for j := 0; j < 4; j++ {
				b0, b1, b2, b3 := cipher.mixColumn(s[j], s[j+4], s[j+8], s[j+12])
				s[j], s[j+4], s[j+8], s[j+12] = b0, b1, b2, b3
			}
		}
		ark(round, cipher.t1)
	}
	final := &cipher.keys[1]
	for i := 0; i < 4; i++ {
		for j := 0; j < 4; j++ {
			s[4*i+j] ^= final[4*i+j]
		}
	}
	out := make([]byte, 16)
	copy(out, s[:])
	return out
}

// ---- (*aesV3).encrypt：把 31 字节分组的隐藏位用 2 次 block 变换后再散回原位 ----

var hgMedusaBitPlane = [8]struct {
	off  int
	sh   int
	mask byte
}{
	{0, 4, 0x02}, {1, 0, 0x40}, {2, 2, 0x01}, {3, -3, 0x80},
	{4, 1, 0x04}, {5, -3, 0x10}, {6, -5, 0x20}, {7, 4, 0x08},
}

func hgMedusaTable(data []byte) [32]byte {
	var table [32]byte
	for i := 0; i < 31; i++ {
		base := 8 * i
		var value byte
		for _, plane := range hgMedusaBitPlane {
			b := data[base+plane.off]
			var x byte
			if plane.sh >= 0 {
				x = b >> uint(plane.sh)
			} else {
				x = b << uint(-plane.sh)
			}
			value |= x & plane.mask
		}
		table[i] = value
	}
	table[31] = 0x01
	return table
}

func (cipher *hgMedusaAes) encrypt(data, iv []byte) []byte {
	table := hgMedusaTable(data)
	prev := make([]byte, 16)
	copy(prev, iv)
	var chain [32]byte
	for off := 0; off < 32; off += 16 {
		block := make([]byte, 16)
		for j := 0; j < 16; j++ {
			block[j] = table[off+j] ^ prev[j]
		}
		prev = cipher.block(block)
		copy(chain[off:], prev)
	}
	out := make([]byte, len(data))
	copy(out, data)
	for i := 0; i < 31; i++ {
		v := chain[i]
		base := 8 * i
		for _, plane := range hgMedusaBitPlane {
			var value, target byte
			if plane.sh >= 0 {
				value = (v & plane.mask) << uint(plane.sh)
				target = (plane.mask << uint(plane.sh))
			} else {
				value = (v & plane.mask) >> uint(-plane.sh)
				target = plane.mask >> uint(-plane.sh)
			}
			out[base+plane.off] = (out[base+plane.off] & ^target) | value
		}
	}
	return append([]byte{chain[31]}, out...)
}

// ---- keyHash / xmxor ----

func hgMedusaKeyHash(seed uint32) ([]byte, [4]byte) {
	buf := make([]byte, 0, 2*len(hgMedusaSignKeyBytes)+4)
	buf = append(buf, hgMedusaSignKeyBytes...)
	buf = binary.LittleEndian.AppendUint32(buf, seed)
	buf = append(buf, hgMedusaSignKeyBytes...)
	digest := hongguoSM3(buf)
	b := byte(seed >> 16)
	x := ((seed >> 5) & 0x7f800) | (seed >> 24)
	x ^= uint32(b >> 5)
	var key [4]byte
	binary.LittleEndian.PutUint32(key[:], ^(uint32(b) ^ x))
	return digest[:], key
}

func hgMedusaRotl8(value byte) byte { return value<<4 | value>>4 }

func hgMedusaRotl8Three(value byte) byte { return value<<3 | value>>5 }

func hgMedusaXmxor(src, key []byte) []byte {
	n := len(src)
	out := make([]byte, n)
	for i := 0; i < n; i++ {
		j := (i & 7) * 4
		a, b := key[j], key[j+1]
		x := hgMedusaRotl8(src[i])
		x += a
		x = ^x
		x ^= b
		x = hgMedusaRotl8Three(x)
		b2 := b + x
		out[n-1-i] = ^(b2 ^ a)
	}
	if n < 4 {
		return out
	}
	t := out[n-2] ^ out[n-1]
	a0 := out[0]
	v0 := (0xff - t) + a0
	out[0] = v0
	r10 := out[n-1] ^ v0 ^ 0xfe
	v1 := r10 + out[1]
	out[1] = v1
	r8 := (t - a0) ^ hgMedusaRotl8Three(v1) ^ 0x02
	out[2] += r8
	for i := 0; i < n-4; i++ {
		v := ^(out[i+1] ^ hgMedusaRotl8Three(out[i+2]) ^ byte(i+3))
		out[i+3] += v
	}
	out[n-1] = out[n-2] ^ out[n-1]
	var total byte
	for i := 1; i < n; i++ {
		total += out[i]
	}
	out[0] = total + (out[0] ^ out[1])
	return out
}

// ---- 组包与整条流水线 ----

func hgMedusaConcat(parts ...[]byte) []byte {
	var out []byte
	for _, part := range parts {
		out = append(out, part...)
	}
	return out
}

func hgMedusaDeviceProto(devID, s2 string) []byte {
	parts := [][]byte{
		hgMedusaSint(1, 1), hgMedusaSint(2, 2), hgMedusaString(3, devID),
	}
	if s2 != "" {
		parts = append(parts, hgMedusaString(4, s2))
	}
	parts = append(parts,
		hgMedusaString(5, "Ai6svO3PyrwDOUSmO6ZcResxu"),
		hgMedusaString(6, "!noperm!"),
		hgMedusaSint(7, -888888), hgMedusaSint(8, -888888), hgMedusaSint(9, 3),
		hgMedusaSint(10, -888888), hgMedusaString(11, "!notset!"),
		hgMedusaString(12, "Asia/Shanghai,8"), hgMedusaString(13, "zh_CN"),
		hgMedusaSint(14, 4),
		hgMedusaFloat(16, 255.24993896484375), hgMedusaFloat(17, 35.58599090576172),
		hgMedusaFloat(18, 3.467449188232422), hgMedusaFloat(19, 3.467449188232422),
		hgMedusaFloat(20, 255.1754913330078), hgMedusaFloat(21, 42.17544174194336),
		hgMedusaString(22, "16"), hgMedusaSint(23, 41), hgMedusaSint(24, 36),
		hgMedusaSint(25, 1728388016635), hgMedusaSint(26, 1728388016635),
		hgMedusaSint(27, 1728388016635), hgMedusaSint(28, 1728388016637),
		hgMedusaSint(29, -1),
		hgMedusaString(30, "25053RT47C"), hgMedusaString(31, "Redmi"),
		hgMedusaString(32, "25053RT47C"), hgMedusaString(33, "25053RT47C"),
		hgMedusaString(34, "Xiaomi"), hgMedusaString(35, "Redmi"),
		hgMedusaString(36, "Redmi"), hgMedusaSint(38, 31),
	)
	return hgMedusaConcat(parts...)
}

// hgMedusaBuild 生成 X-Medusa 头部（不含 "X-Medusa: " 前缀）。
//
// flag 对应竞品 BuildMedusaFor 的第 5 个参数（同时决定 aesV3 变体）；
// s2 对应第 6/7 个参数（AppProfile 里的辅助字符串）；devID/instID 为
// AppProfile 两个整数字段（device_id / install_id）转成的十进制串。
func hgMedusaBuild(flag int, s2, devID, instID string, now time.Time) string {
	return hgMedusaBuildWith(flag, s2, devID, instID,
		rand.Uint32(), 100+rand.Intn(0x15), 10001+rand.Intn(0x7d0), rand.Uint32(), rand.Uint32())
}

// hgMedusaBuildWith 与 hgMedusaBuild 相同，但随机数由调用方给出（便于用模拟器基准做回归）。
func hgMedusaBuildWith(flag int, s2, devID, instID string, r1 uint32, launch, pidValue int, r2, r3 uint32) string {

	p1 := hgMedusaConcat(
		hgMedusaSint(1, 111), hgMedusaSint(2, 10),
		hgMedusaSint(3, 694367), hgMedusaSint(5, 586952199),
	)
	p2 := hgMedusaConcat(
		hgMedusaSint(1, int64(flag)), hgMedusaSint(2, -2), hgMedusaSint(4, 200),
	)
	device := hgMedusaDeviceProto(devID, s2)
	p3 := hgMedusaConcat(
		hgMedusaSint(1, int64(launch)), hgMedusaSint(2, 146331399),
		hgMedusaSint(3, 146331396), hgMedusaSint(5, 7),
		hgMedusaString(6, hgMedusaEnvTag6), hgMedusaSint(7, int64(pidValue)),
		hgMedusaBlob(12, device), hgMedusaBlob(13, p2),
	)
	p4 := hgMedusaConcat(
		hgMedusaBlob(1, hgMedusaP4F1), hgMedusaSint(2, 3),
		hgMedusaSint(3, int64(r1&0xff)),
		hgMedusaString(4, devID), hgMedusaString(6, instID),
		hgMedusaString(8, hgMedusaDevTag8), hgMedusaSint(9, 67503104),
		hgMedusaBlob(10, hgMedusaAcc8), hgMedusaSint(12, 0),
		hgMedusaBlob(13, hgMedusaP4F13), hgMedusaBlob(14, hgMedusaP4F14),
		hgMedusaBlob(15, p1),
		hgMedusaString(16, "AXYQOS6n2m60x1fVZHIrH3iol"),
		hgMedusaSint(17, int64(flag)),
		hgMedusaBlob(19, hgMedusaP4F19),
		hgMedusaString(20, "none"), hgMedusaSint(21, 312),
		hgMedusaBlob(23, p3), hgMedusaString(24, hgMedusaJSON24),
	)

	if hgMedusaDebug != nil {
		hgMedusaDebug("p4", p4)
		hgMedusaDebug("p3", p3)
		hgMedusaDebug("p1", p1)
		hgMedusaDebug("p2", p2)
		hgMedusaDebug("dev", device)
	}
	hash, xorKey := hgMedusaKeyHash(r2)
	payload := hgMedusaXmxor(p4, hash)
	acc := hgMedusaConcat(hgMedusaAcc8, payload)
	for i, j := 0, len(acc)-1; i < j; i, j = i+1, j-1 {
		acc[i], acc[j] = acc[j], acc[i]
	}
	for i := 0; i < len(acc); i++ {
		acc[i] ^= xorKey[(^i)&3]
	}

	h1 := byte(0x22)
	if flag >= 0 && flag < len(hgMedusaH1ByFlag) {
		h1 = hgMedusaH1ByFlag[flag]
	}
	check := uint32(hgMedusaH0Mask&0x3f)<<14 | uint32(h1&0x3f)<<8 | 0x18000001
	header := []byte{0x35, byte(r3), 0x00, 0x00, 0x00}
	header = binary.LittleEndian.AppendUint32(header, check)
	data := hgMedusaConcat(header, acc, []byte{byte(r2 >> 16), byte(r2 >> 24)})
	if hgMedusaDebug != nil {
		hgMedusaDebug("hash", hash)
		hgMedusaDebug("acc", acc)
		hgMedusaDebug("data", data)
	}

	cipher := newHgMedusaAes(hgMedusaAESKeyBytes, flag)
	sealed := cipher.encrypt(data, hgMedusaAESIVBytes)

	head := make([]byte, 20)
	for i, b := range hgMedusaHead20 {
		head[i] = b ^ byte(flag)
	}
	frame := hgMedusaConcat(head,
		[]byte{byte(r2), byte(r2 >> 8)}, []byte{0x00, 0x01}, sealed)
	return base64.StdEncoding.EncodeToString(frame)
}

// hongguoMedusa 生成 X-Medusa：竞品 SignMode=1（UGC 写接口）的第二个最小签名头。
func hongguoMedusa(request *http.Request, now time.Time) string {
	if request == nil || request.URL == nil {
		return ""
	}
	query := request.URL.Query()
	devID := query.Get("device_id")
	instID := query.Get("iid")
	if devID == "" {
		devID = "0"
	}
	if instID == "" {
		instID = "0"
	}
	return hgMedusaBuild(0, "", devID, instID, now)
}
