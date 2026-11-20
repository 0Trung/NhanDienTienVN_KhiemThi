import { describe, expect, it } from 'vitest';
import { LogFormatError, REQUIRED_COLUMNS, parseLog, splitCsv } from '../../tools/metrics-from-log/parse-csv';

const HEADER = REQUIRED_COLUMNS.join(',');
/** Dòng hợp lệ: đọc đúng 20.000, có tiền thật 20.000, một tờ, trễ 850 ms, giọng nói offline tốt. */
const GOOD_ROW = '2026-11-20T09:00:00,AI-01,DONE,CONFIDENT_SINGLE,20000,20000,1,1,850,true';
const csv = (...rows: string[]): string => [HEADER, ...rows].join('\n');

/** Bắt lỗi LogFormatError để kiểm tra nội dung thông báo. */
function failure(text: string): LogFormatError {
  try {
    parseLog(text);
  } catch (error) {
    if (error instanceof LogFormatError) return error;
    throw error;
  }
  throw new Error('parseLog đáng lẽ phải ném LogFormatError');
}

describe('parseLog · cột bắt buộc', () => {
  it('thiếu cột: báo rõ TÊN từng cột thiếu và các cột đang có, ở dòng tiêu đề', () => {
    const error = failure('timestamp,scenarioId,state,status,announcedTotal,groundTruthTotal,noteCountDetected,noteCountTrue\nx,y,z,w,1,1,1,1');
    expect(error.name).toBe('LogFormatError');
    expect(error.line).toBe(1);
    expect(error.message).toContain('thiếu cột bắt buộc: latencyMs, offlineVoiceOk');
    expect(error.message).toContain('Các cột đang có: timestamp,');
  });

  it.each(REQUIRED_COLUMNS)('thiếu riêng cột %s vẫn bị phát hiện', (column) => {
    const columns = REQUIRED_COLUMNS.filter((c) => c !== column);
    expect(failure(columns.join(',')).message).toContain(`thiếu cột bắt buộc: ${column}.`);
  });

  it.each([{ text: '', why: 'file rỗng' }, { text: '\n\r\n  \n', why: 'chỉ có dòng trắng' }])('$why', ({ text }) => {
    expect(failure(text).message).toContain('nhật ký rỗng');
  });

  it('chỉ có dòng tiêu đề: không có lượt nào', () => {
    expect(parseLog(HEADER)).toEqual([]);
  });

  it('cột thừa được bỏ qua và thứ tự cột tuỳ ý', () => {
    const shuffled = ['note', ...[...REQUIRED_COLUMNS].reverse()].join(',');
    const row = ['ghi chú', 'true', '850', '1', '1', '20000', '20000', 'CONFIDENT_SINGLE', 'DONE', 'AI-01', 'ts'].join(',');
    expect(parseLog(`${shuffled}\n${row}`)[0]).toMatchObject({ scenarioId: 'AI-01', announcedTotal: 20000, latencyMs: 850, offlineVoiceOk: true });
  });
});

describe('parseLog · dòng hợp lệ', () => {
  it('đọc đủ mười cột với đúng kiểu và số dòng trong file', () => {
    expect(parseLog(csv(GOOD_ROW))).toEqual([{
      line: 2, timestamp: '2026-11-20T09:00:00', scenarioId: 'AI-01', state: 'DONE', status: 'CONFIDENT_SINGLE',
      announcedTotal: 20000, groundTruthTotal: 20000, noteCountDetected: 1, noteCountTrue: 1, latencyMs: 850, offlineVoiceOk: true,
    }]);
  });

  it('ô trống của cột tuỳ chọn là null (không đo), không phải 0', () => {
    const [row] = parseLog(csv('t,AI-02,READY,REJECTED,,50000,,1,,'));
    expect(row).toMatchObject({ announcedTotal: null, noteCountDetected: null, latencyMs: null, offlineVoiceOk: null });
  });

  it('không có tiền: groundTruthTotal = 0 và noteCountTrue = 0 được chấp nhận', () => {
    expect(parseLog(csv('t,AI-09,READY,NO_MONEY,,0,0,0,,'))[0]).toMatchObject({ groundTruthTotal: 0, noteCountTrue: 0 });
  });

  it.each([
    ['true', true], ['TRUE', true], ['1', true], ['yes', true],
    ['false', false], ['False', false], ['0', false], ['no', false],
  ])('offlineVoiceOk = %s → %s', (raw, expected) => {
    expect(parseLog(csv(`t,VOICE-01,DONE,OK,20000,20000,1,1,850,${raw}`))[0]?.offlineVoiceOk).toBe(expected);
  });

  it('chịu được BOM, CRLF, dòng trắng cuối file và ô trong ngoặc kép có dấu phẩy', () => {
    const text = `\uFEFF${HEADER}\r\n"2026-11-20, 09:00",AI-01,"DONE, ok",CONFIDENT_SINGLE,20000,20000,1,1,850,true\r\n\r\n`;
    expect(parseLog(text)).toHaveLength(1);
    expect(parseLog(text)[0]).toMatchObject({ timestamp: '2026-11-20, 09:00', state: 'DONE, ok' });
  });

  it('ngoặc kép nhân đôi thoát được dấu ngoặc kép, ô nhiều dòng không làm lệch số dòng của lượt sau', () => {
    const text = csv('"a ""b""\nc",AI-01,DONE,OK,20000,20000,1,1,850,true', GOOD_ROW);
    const rows = parseLog(text);
    expect(rows[0]?.timestamp).toBe('a "b"\nc');
    expect(rows.map((r) => r.line)).toEqual([2, 4]);
  });
});

describe('parseLog · dòng sai: thông báo có số dòng và tên cột', () => {
  it.each([
    { name: 'số ô khác tiêu đề', row: 'a,b,c', line: 2, message: 'có 3 ô nhưng tiêu đề có 10 cột' },
    { name: 'announcedTotal không phải số', row: 't,AI-01,S,T,hai chục,20000,1,1,850,true', line: 2, message: 'cột announcedTotal = "hai chục"' },
    { name: 'announcedTotal âm', row: 't,AI-01,S,T,-5,20000,1,1,850,true', line: 2, message: 'cột announcedTotal = "-5"' },
    { name: 'noteCountTrue không nguyên', row: 't,AI-01,S,T,20000,20000,1,1.5,850,true', line: 2, message: 'cột noteCountTrue = "1.5" không phải số nguyên không âm' },
    { name: 'latencyMs không phải số', row: 't,AI-01,S,T,20000,20000,1,1,nhanh,true', line: 2, message: 'cột latencyMs = "nhanh"' },
    { name: 'scenarioId trống', row: 't,,S,T,20000,20000,1,1,850,true', line: 2, message: 'cột scenarioId bắt buộc' },
    { name: 'groundTruthTotal trống', row: 't,AI-01,S,T,20000,,1,1,850,true', line: 2, message: 'cột groundTruthTotal bắt buộc' },
    { name: 'noteCountTrue trống', row: 't,AI-01,S,T,20000,20000,1,,850,true', line: 2, message: 'cột noteCountTrue bắt buộc' },
    { name: 'sự thật mâu thuẫn: không có tờ nào mà tổng > 0', row: 't,AI-01,S,T,20000,50000,1,0,850,true', line: 2, message: 'noteCountTrue = 0 mâu thuẫn với groundTruthTotal = 50000' },
    { name: 'sự thật mâu thuẫn: có tờ mà tổng = 0', row: 't,AI-01,S,T,,0,1,2,850,true', line: 2, message: 'noteCountTrue = 2 mâu thuẫn với groundTruthTotal = 0' },
    { name: 'offlineVoiceOk không hiểu được', row: 't,AI-01,S,T,20000,20000,1,1,850,có', line: 2, message: 'cột offlineVoiceOk = "có"' },
  ])('$name', ({ row, line, message }) => {
    const error = failure(csv(row));
    expect(error.line).toBe(line);
    expect(error.message).toContain(`Dòng ${line}:`);
    expect(error.message).toContain(message);
  });

  it('lỗi ở dòng thứ ba nêu đúng "Dòng 3"', () => {
    expect(failure(csv(GOOD_ROW, 'a,b')).message).toContain('Dòng 3:');
  });

  it('ngoặc kép mở nhưng không đóng', () => {
    expect(failure(csv('"chưa đóng,AI-01,S,T,1,1,1,1,1,true')).message).toContain('ngoặc kép mở nhưng không đóng');
  });
});

describe('splitCsv', () => {
  it('bỏ dòng trắng nhưng giữ ô trống ở giữa dòng', () => {
    expect(splitCsv('a,,c\n\n,,\nd,e,f')).toEqual([
      { line: 1, fields: ['a', '', 'c'] },
      { line: 3, fields: ['', '', ''] },
      { line: 4, fields: ['d', 'e', 'f'] },
    ]);
  });
});