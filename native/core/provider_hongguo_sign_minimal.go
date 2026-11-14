package core

import (
	"crypto/md5"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"math/bits"
	"net/http"
	"strconv"
	"time"
)

// hongguoSignModeKey 选择 UGC 写接口的签名方式（调试用）：
//
//	""/"comment" 现有 X-Gorgon/Argus/Ladon 方案
//	"none"       不带任何 X-* 签名头
//	"fake"       带明显错误的 X-Helios/X-Medusa
//	"minimal"    只带 X-Helios/X-Medusa（竞品 SignMode=1 的头部集合）
type hongguoSignModeKey struct{}

// 竞品 hg-go/pkg/crypto.AppProfile 里的两个常量字段。
// License 值取自竞品 X-Ladon 明文（"<ts>-1611921764-<aid>"）以及
// crypto.AppProfile{License int @0x18}；AID 与请求 query 里的 aid 一致。
const (
	hongguoSignLicense = 1611921764
	hongguoSignAID     = 8662
)

// hongguoSignMinimal 生成竞品 SignMode=1（UGC 写接口）使用的最小签名头：
// 只包含 X-Helios 与 X-Medusa，其余 7 个 X-* 头不下发。
func hongguoSignMinimal(request *http.Request, now time.Time) (helios, medusa string) {
	return hongguoHelios(request, now), hongguoMedusa(request, now)
}

// hongguoHelios 复刻竞品 crypto.HeliosFor（0x1406866e0 → heliosWith 0x140686780）。
//
// 反汇编还原出的结构（与已有 X-Ladon 实现同构）：
//
//	s      = fmt.Sprint(profile.seed)          // 结构里的一个 int 字段
//	buf    = le32(profile.license) ‖ s          // asm: ES=EBX 写在 buf[0]
//	hexd   = hex(md5(buf))                      // 表 "0123456789abcdef"，32 字节
//	words  = LE64(hexd[0:]), LE64(hexd[8:]), LE64(hexd[16:]), LE64(hexd[24:])
//	keys   = 34 轮密钥派生（与 X-Ladon 完全一致：
//	         mixed = (ror64(right,8) + left) ^ i; left = mixed ^ rol64(left,3)）
//	plain  = fmt.Sprintf("%d-%d-%d", ts, license, aid)
//	ct     = Feistel_encrypt(pkcs7(plain), keys)  // 每 16 字节一轮
//	header = base64(ct)
//
// 仍未从 asm 100% 断定的两点（都集中在 seed/前缀上，用常量便于校准）：
//   - fmt.Sprint 的实参：结构首字段，按竞品 AppProfile 布局推测为 AID；
//   - le32 前缀取 License 还是 AID：按 X-Ladon 的明文顺序推测为 License。
func hongguoHelios(request *http.Request, now time.Time) string {
	timestamp := uint32(now.Unix())
	seed := hongguoSignAID

	buf := make([]byte, 4, 4+8)
	binary.LittleEndian.PutUint32(buf, uint32(hongguoSignLicense))
	buf = append(buf, strconv.Itoa(seed)...)

	sum := md5.Sum(buf)
	digest := []byte(hex.EncodeToString(sum[:]))
	left, right := binary.LittleEndian.Uint64(digest), binary.LittleEndian.Uint64(digest[8:])
	queue := []uint64{binary.LittleEndian.Uint64(digest[16:]), binary.LittleEndian.Uint64(digest[24:])}
	var keys [34]uint64
	for i := range keys {
		keys[i] = left
		mixed := (bits.RotateLeft64(right, -8) + left) ^ uint64(i)
		queue = append(queue, mixed)
		left = mixed ^ bits.RotateLeft64(left, 3)
		right, queue = queue[0], queue[1:]
	}

	plain := strconv.FormatUint(uint64(timestamp), 10) + "-" +
		strconv.Itoa(hongguoSignLicense) + "-" + strconv.Itoa(seed)
	data := hongguoCommentPad([]byte(plain))
	for offset := 0; offset < len(data); offset += 16 {
		blockLeft := binary.LittleEndian.Uint64(data[offset:])
		blockRight := binary.LittleEndian.Uint64(data[offset+8:])
		for _, key := range keys {
			blockRight = key ^ (blockLeft + bits.RotateLeft64(blockRight, -8))
			blockLeft = blockRight ^ bits.RotateLeft64(blockLeft, 3)
		}
		binary.LittleEndian.PutUint64(data[offset:], blockLeft)
		binary.LittleEndian.PutUint64(data[offset+8:], blockRight)
	}
	return base64.StdEncoding.EncodeToString(data)
}

// hongguoMedusa 对应竞品 crypto.BuildMedusaFor（0x14068b640）。
// 完整还原实现见 provider_hongguo_medusa.go（aesV3 分组密码 + 4 段 protobuf +
// keyHash/xmxor + 帧头 + base64），已用 Unicorn 模拟器逐字节校验。
