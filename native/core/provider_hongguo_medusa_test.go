package core

import "testing"

// TestHgMedusaBuildVector 固定向量回归：期望值由 Unicorn 模拟器直接执行竞品
// crypto.BuildMedusaFor 得到（同时与独立的 Python 模型逐字节一致）。
func TestHgMedusaBuildVector(t *testing.T) {
	const want = "BQAAAC1LT8pJdQ1DP7WuLCJtzFYBAAABjRUAABAIA6IGODqIMW/iS4HaVPmE0t3AqUC/5CGHkUYWYsHQkqHhQEfMFIKDUfk" // 仅前缀，实际比较见下
	got := hgMedusaBuildWith(0, "", "0", "0", 0, 100, 10001, 1, 0)
	if len(got) != 896 {
		t.Fatalf("medusa length = %d, want 896", len(got))
	}
	if len(want) < 64 || got[:64] != want[:64] {
		t.Fatalf("medusa prefix = %q, want %q", got[:64], want[:64])
	}
}
