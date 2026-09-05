export const NULL_INDICATORS = [
  'null',
  'none',
  '',
  'no pattern',
  'no clear pattern',
  'không phát hiện',
  'chưa đủ',
  'cần thêm',
  'không rõ',
  'không tìm thấy',
  'không detect',
  'không có mẫu',
];

export const SHARED_SALIENCE_THRESHOLD = 0.8;
export const SUPPORTED_LANGUAGES = [
  'English',
  'Vietnamese',
  'Chinese',
  'Arabic',
  'Japanese',
  'Spanish',
  'French',
  'Korean',
  'German',
  'Portuguese',
];
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

export const DEFAULT_LANGUAGE: SupportedLanguage = 'English';

export function isSupportedLanguage(value: string): value is SupportedLanguage {
  return (SUPPORTED_LANGUAGES as readonly string[]).includes(value);
}
