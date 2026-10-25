import { sanitizePollText } from './role-utils.js';

export function buildNativePollPayload(args = {}) {
  const question = sanitizePollText(args.question || 'Bình chọn', 300).trim();
  const options = (Array.isArray(args.options) ? args.options : [args.option1, args.option2, args.option3, args.option4])
    .map(value => sanitizePollText(value || '', 300).trim())
    .filter(Boolean)
    .slice(0, 4);
  if (options.length < 2) throw new Error('Poll cần ít nhất hai lựa chọn khác nhau.');
  if (new Set(options.map(value => value.toLocaleLowerCase('vi'))).size !== options.length) {
    throw new Error('Các lựa chọn poll không được trùng nhau.');
  }
  return {
    poll: {
      question: { text: question || 'Bình chọn' },
      answers: options.map(text => ({ poll_media: { text } })),
      duration: 24,
      allow_multiselect: false
    },
    allowedMentions: { parse: [] }
  };
}
