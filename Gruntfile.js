'use strict';

const path = require('path');
const util = require('util');
const nconf = require('nconf');
nconf.argv().env({
	separator: '__',
});
const winston = require('winston');
const fork = require('child_process').fork;
const sleep = util.promisify(setTimeout);
const env = process.env;
var worker;

env.NODE_ENV = env.NODE_ENV || 'development';

const configFile = path.resolve(__dirname, nconf.any(['config', 'CONFIG']) || 'config.json');
const prestart = require('./src/prestart');
prestart.loadConfig(configFile);

var db = require('./src/database');

module.exports = function (grunt) {
	var args = [];

	if (!grunt.option('verbose')) {
		args.push('--log-level=info');
		nconf.set('log-level', 'info');
	}
	prestart.setupWinston();

	grunt.initConfig({
		watch: {},
	});

	grunt.loadNpmTasks('grunt-contrib-watch');

	grunt.registerTask('default', ['watch']);

	grunt.registerTask('init', async function () {
		var done = this.async();
		let plugins = [];
		if (!process.argv.includes('--core')) {
			await db.init();
			plugins = await db.getSortedSetRange('plugins:active', 0, -1);
			addBaseThemes(plugins);
			if (!plugins.includes('nodebb-plugin-composer-default')) {
				plugins.push('nodebb-plugin-composer-default');
			}
		}

		const styleUpdated_Client = plugins.map(p => 'node_modules/' + p + '/*.scss')
			.concat(plugins.map(p => 'node_modules/' + p + '/*.css'))
			.concat(plugins.map(p => 'node_modules/' + p + '/+(public|static|scss)/**/*.scss'))
			.concat(plugins.map(p => 'node_modules/' + p + '/+(public|static)/**/*.css'));

		const styleUpdated_Admin = plugins.map(p => 'node_modules/' + p + '/*.scss')
			.concat(plugins.map(p => 'node_modules/' + p + '/*.css'))
			.concat(plugins.map(p => 'node_modules/' + p + '/+(public|static|scss)/**/*.scss'))
			.concat(plugins.map(p => 'node_modules/' + p + '/+(public|static)/**/*.css'));

		const clientUpdated = plugins.map(p => 'node_modules/' + p + '/+(public|static)/**/*.js');
		const serverUpdated = plugins.map(p => 'node_modules/' + p + '/*.js')
			.concat(plugins.map(p => 'node_modules/' + p + '/+(lib|src)/**/*.js'));

		const templatesUpdated = plugins.map(p => 'node_modules/' + p + '/+(public|static|templates)/**/*.tpl');
		const langUpdated = plugins.map(p => 'node_modules/' + p + '/+(public|static|languages)/**/*.json');

		grunt.config(['watch'], {
			styleUpdated_Client: {
				files: [
					'public/scss/**/*.scss',
					...styleUpdated_Client,
				],
				options: {
					interval: 1000,
				},
			},
			styleUpdated_Admin: {
				files: [
					'public/scss/**/*.scss',
					...styleUpdated_Admin,
				],
				options: {
					interval: 1000,
				},
			},
			clientUpdated: {
				files: [
					...clientUpdated,
					'node_modules/benchpressjs/build/benchpress.js',
				],
				options: {
					interval: 1000,
				},
			},
			serverUpdated: {
				files: [
					'app.js',
					'install/*.js',
					'src/**/*.js',
					'public/src/modules/translator.common.js',
					'public/src/modules/helpers.common.js',
					'public/src/utils.common.js',
					serverUpdated,
					'!src/upgrades/**',
				],
				options: {
					interval: 1000,
				},
			},
			templatesUpdated: {
				files: [
					'src/views/**/*.tpl',
					...templatesUpdated,
				],
				options: {
					interval: 1000,
				},
			},
			langUpdated: {
				files: [
					'public/language/en-GB/*.json',
					'public/language/en-GB/**/*.json',
					...langUpdated,
				],
				options: {
					interval: 1000,
				},
			},
		});
		const build = require('./src/meta/build');
		if (!grunt.option('skip')) {
			await build.build(true, { webpack: false });
		}
		run();
		// the build step writes a lot of tpl/js files,
		// wait a second before stating webpack watch,
		// this prevents unnessary watch triggers
		await sleep(1000);
		await build.webpack({ watch: true });
		done();
	});

	function run() {
		if (worker) {
			worker.kill();
		}
		worker = fork('app.js', args, {
			env: env,
		});
	}

	grunt.task.run('init');

	grunt.event.removeAllListeners('watch');
	grunt.event.on('watch', function update(action, filepath, target) {
		var compiling;
		if (target === 'styleUpdated_Client') {
			compiling = 'clientCSS';
		} else if (target === 'styleUpdated_Admin') {
			compiling = 'acpCSS';
		} else if (target === 'clientUpdated') {
			compiling = 'js';
		} else if (target === 'templatesUpdated') {
			compiling = 'tpl';
		} else if (target === 'langUpdated') {
			compiling = 'lang';
		} else if (target === 'serverUpdated') {
			// empty require cache
			const paths = ['./src/meta/build.js', './src/meta/index.js'];
			paths.forEach(p => delete require.cache[require.resolve(p)]);
			return run();
		}

		require('./src/meta/build').build([compiling], { webpack: false }, function (err) {
			if (err) {
				winston.error(err.stack);
			}
			if (worker) {
				worker.send({ compiling: compiling });
			}
		});
	});
};

function addBaseThemes(plugins) {
	const themeId = plugins.find(p => p.startsWith('nodebb-theme-'));
	if (!themeId) {
		return plugins;
	}
	function getBaseRecursive(themeId) {
		try {
			const baseTheme = require(themeId + '/theme').baseTheme;

			if (baseTheme) {
				plugins.push(baseTheme);
				getBaseRecursive(baseTheme);
			}
		} catch (err) {
			console.log(err);
		}
	}

	getBaseRecursive(themeId);
	return plugins;
}
