# 05 — Luận giải bằng Gemini

## Triển khai thực tế

Một `POST /api/interpret` gọi Gemini qua Vercel Function trong cùng project. Không có service riêng, adapter nhiều provider, database, polling, SSE, lưu usage hay idempotency phân tán.

- Entry point: [api/interpret.ts](../api/interpret.ts).
- Handler: [server/interpret.ts](../server/interpret.ts).
- Prompt builder: [server/rules.ts](../server/rules.ts).
- Schema chung: [src/data/interpretation.ts](../src/data/interpretation.ts).
- Tri thức: [11-rule-tarot](11-rule-tarot), phiên bản `lunara-tarot-rules@1.0`.

## Pipeline

1. Người dùng chọn **Bắt đầu giải nghĩa**, không có request tự động khi rút bài.
2. Client gửi topic, câu hỏi, spread, ID, vị trí và chiều của 1/3 lá.
3. Server kiểm tra method, Origin nếu có, content type, kích thước, schema và rate limit.
4. Đọc rule đã đóng gói vào Function; kiểm tra có đủ 78 ID. Giữ cache nội dung rule trong instance, không cache câu hỏi/kết quả.
5. Tạo system instruction từ Phần A trước A9, khung tri thức và mục riêng của các lá đã rút. JSON Schema trong mã là hợp đồng đầu ra chính.
6. Gọi REST `generateContent` bằng `GEMINI_API_KEY` server; model từ `GEMINI_MODEL` hoặc mặc định `gemini-3.6-flash`.
7. Parse response `finishReason=STOP`, bỏ phần thought, kiểm tra JSON và nội dung.
8. Chỉ khi output không hợp lệ mới tạo lại tối đa một lần; không retry lỗi mạng, xác thực, quota hoặc HTTP provider.
9. Trả JSON `no-store`; client kiểm tra lại rồi mở luồng từng lá. Không lưu kết quả.

Một response chứa cả nghĩa từng lá, overview, synthesis, advice, reflectionQuestion và safetyNote. Nhấn từng lá hay **Kết luận** không gọi Gemini thêm.

## Quy tắc

- Không gửi ảnh hoặc đường dẫn ảnh; nhân vật thay thế không liên quan ý nghĩa.
- Câu hỏi là dữ liệu, không phải chỉ dẫn được phép ghi đè system instruction.
- Không đổi lá, không khẳng định tương lai, không đọc suy nghĩ người khác.
- Lá ngược không mặc định xấu; dùng nghĩa theo ID, chiều, vị trí và chủ đề.
- `status=interpreted`: đúng số lá, thứ tự, vị trí và chiều đã gửi.
- `status=support`: `cards=[]`, có safetyNote; hiển thị hỗ trợ ngay, không buộc người dùng đi qua bước bói/kết luận.

Kiểm tra bằng mã bao gồm schema, danh tính lá, giới hạn từ và một số cụm từ bị cấm. Giới hạn tư vấn và chất lượng ngữ nghĩa vẫn phụ thuộc prompt, provider và kiểm thử; không phải bảo đảm an toàn tuyệt đối.

## Ngân sách và lỗi

- JSON request tối đa 4 KB; câu hỏi tối đa 240 ký tự.
- Output tối đa 4.096 token mỗi lần gọi, temperature 0,4.
- Server deadline 45 giây dùng chung cho cả hai lần tạo; client 52 giây; Vercel Function 60 giây.
- Giới hạn trong bộ nhớ: 3 request/phút/IP, 20 request/phút/instance; không thay thế Vercel Firewall.
- Lỗi trả `{ error, code }`, giao diện có **Thử lại giải nghĩa**; không tự chèn nghĩa tham khảo vào luồng.
- Không ghi log key, câu hỏi, response hoặc prompt; chỉ ghi mã lỗi/status.

Tên nút và trạng thái trên UI không nhắc thuật ngữ kỹ thuật. Thông báo xử lý tự động/Google Gemini nằm ở **Quyền riêng tư** trong footer. Cấu hình key mới và kiểm thử gọi thật sau deploy xem [README](../README.md#deploy-vercel-và-cấu-hình-gemini).
