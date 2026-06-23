// iobroker eslint configuration
import config from '@iobroker/eslint-config';

export default [
    ...config,
    {
        ignores: [
            '.dev-server/',
            '.vscode/',
            '**/*.test.ts',
            //'*.test.js',
            //'test/**/*.js',
            '*.config.mjs',
            'admin/words.js',
            'admin/admin.d.ts',
            '**/adapter-config.d.ts',
        ]
    }
];
