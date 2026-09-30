# FORMAL Case #1｜原始证据获取记录

日期：2026-09-25  
结果：**执行环境阻塞，未接纳任何原始 Artifact**

## 1. 计划获取

需要保存：

- Federal Reserve official raw bytes + publication/retrieval metadata + SHA-256
- Coinbase BTC-USD 1m raw response + request/retrieval metadata + SHA-256

目标行情窗口只是 acquisition envelope，Candidate 仍必须 obey frozen selector。

## 2. 本次失败

在源站 bytes 返回以前就失败：

```text
web open: HTTP 401
curl Fed locator: HTTP 403 from proxy
curl Coinbase endpoint: HTTP 403 from proxy
```

这些响应不是 authoritative source artifact，所以没有伪造 checksum、publication time、candle、T0 或 outcome。

## 3. Admission 后果

```text
input provenance: not established
Fed official bytes: absent
vendor candle bytes: absent
selector on real data: not run
Candidate T0: unset
outcome reveal: not performed
FORMAL Case #1: NOT ADMITTED
```

下一次必须在能访问 authoritative locator 的环境运行，或提供带原始 metadata 的文件。先 checksum，再 parse。

## 4. Adapter 边界

Coinbase raw adapter 已能处理 row mapping、时间戳转换、排序、non-2xx、duplicate 和 gap，但只用 synthetic DEMO rows 验证过。

因此“Adapter 已写好”不能被包装成“真实 FOMC Case 已验证”。
