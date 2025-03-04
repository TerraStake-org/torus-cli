"use strict";

// Makes the script crash on unhandled rejections instead of silently
// ignoring them. In the future, promise rejections that are not handled will
// terminate the Node.js process with a non-zero exit code.
process.on("unhandledRejection", (err) => {
  throw err;
});

import { rollup } from "rollup";
import webpack from "webpack";
import chalk from "chalk";
import { Listr } from "listr2";
import cliui from "cliui";
import parseArgs from "yargs-parser";
import dotenv from "dotenv";
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { Worker } from "worker_threads";
import os from "os";
import glob from "glob-promise";

import generateRollupConfig from "../config/rollup.config.js";
import generateWebpackConfig from "../config/webpack.config.js";
import torusConfig from "../config/torus.config.js";
import paths from "../config/paths.js";
import formatWebpackStats from "../helpers/formatWebpackStats.js";
import formatWebpackMessages from "../helpers/formatWebpackMessages.js";
import formatRollupStats from "../helpers/formatRollupStats.js";
import updatePackageNotification from "../helpers/updatePackage.js";
import { buildHelpText } from "../helpers/constants.js";
import { deleteFolder } from "../helpers/utils.js";

const ui = cliui({ width: process.stdout.columns || 80 });
const CACHE_DIR = path.join(process.cwd(), '.build-cache');
const LAST_BUILD_FILE = path.join(paths.appBuild, '.buildinfo.json');

// Configure worker pool for CPU-intensive tasks
const WORKER_POOL_SIZE = Math.max(1, os.cpus().length - 1);

const aliases = {
  n: "name",
  h: "help",
};

const parseCliArguments = (args) => {
  const options = parseArgs(args, {
    alias: aliases,
    configuration: {
      "parse-numbers": false,
      "camel-case-expansion": false,
    },
  });
  options.name = options.name || torusConfig.name;
  return options;
};

const finalArgs = parseCliArguments([].slice.call(process.argv, 2));

if (paths.dotenv) {
  dotenv.config({ path: paths.dotenv });
}

// Worker pool implementation
class WorkerPool {
  constructor(size) {
    this.size = size;
    this.workers = [];
    this.queue = [];
    this.initialize();
  }
  
  initialize() {
    for (let i = 0; i < this.size; i++) {
      this.workers.push({
        worker: null,
        busy: false,
        id: i
      });
    }
  }
  
  async runTask(taskFn, data) {
    return new Promise((resolve, reject) => {
      const task = { taskFn: taskFn.toString(), data, resolve, reject };
      this.queue.push(task);
      this.processQueue();
    });
  }
  
  processQueue() {
    if (this.queue.length === 0) return;
    
    const availableWorker = this.workers.find(w => !w.busy);
    if (!availableWorker) return;
    
    const task = this.queue.shift();
    availableWorker.busy = true;
    
    const workerScript = `
      const { parentPort, workerData } = require('worker_threads');
      
      async function executeTask() {
        const taskFn = eval(workerData.taskFn);
        try {
          const result = await taskFn(workerData.data);
          parentPort.postMessage({ success: true, result });
        } catch (error) {
          parentPort.postMessage({ 
            success: false, 
            error: { message: error.message, stack: error.stack }
          });
        }
      }
      
      executeTask();
    `;
    
    const worker = new Worker(workerScript, { 
      eval: true,
      workerData: { taskFn: task.taskFn, data: task.data } 
    });
    
    worker.on('message', (message) => {
      if (message.success) {
        task.resolve(message.result);
      } else {
        const error = new Error(message.error.message);
        error.stack = message.error.stack;
        task.reject(error);
      }
      
      worker.terminate();
      availableWorker.busy = false;
      this.processQueue();
    });
    
    worker.on('error', (err) => {
      task.reject(err);
      worker.terminate();
      availableWorker.busy = false;
      this.processQueue();
    });
    
    availableWorker.worker = worker;
  }
}

// Create the worker pool
const workerPool = new WorkerPool(WORKER_POOL_SIZE);

// Cache management functions
async function setupCache() {
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true });
    return true;
  } catch (err) {
    console.log(chalk.yellow('Could not create cache directory, skipping cache.'));
    return false;
  }
}

async function getSourceFiles(config) {
  // Basic implementation - for real use, should parse config to find all dependencies
  if (config.input) {
    if (typeof config.input === 'string') {
      return [config.input];
    } else if (Array.isArray(config.input)) {
      return config.input;
    } else if (typeof config.input === 'object') {
      return Object.values(config.input);
    }
  }
  return [];
}

async function getCacheKey(config, filename) {
  // Create a hash of the config and source files
  const configHash = crypto
    .createHash('md5')
    .update(JSON.stringify(config))
    .digest('hex');
  
  // Get stats of all source files
  const sourceFiles = await getSourceFiles(config);
  const statsPromises = sourceFiles.map(file => fs.stat(file).catch(() => ({ mtimeMs: 0 })));
  const stats = await Promise.all(statsPromises);
  
  // Create a composite hash of file paths and mtimes
  const filesHash = crypto
    .createHash('md5')
    .update(
      sourceFiles
        .map((file, i) => `${file}:${stats[i].mtimeMs}`)
        .join('|')
    )
    .digest('hex');
  
  return `${filename}-${configHash}-${filesHash}`;
}

async function checkCache(cacheKey) {
  const cachePath = path.join(CACHE_DIR, cacheKey);
  try {
    await fs.access(cachePath);
    return cachePath;
  } catch {
    return null;
  }
}

async function saveToCache(cacheKey, outputFiles) {
  const cachePath = path.join(CACHE_DIR, cacheKey);
  await fs.writeFile(cachePath, JSON.stringify(outputFiles));
}

// Helper for incremental builds
async function getEntryPointDependencies() {
  // For a simplified implementation, we'll just track entry files
  const rollupConfigs = Array.isArray(generateRollupConfig(finalArgs.name)) 
    ? generateRollupConfig(finalArgs.name) 
    : [generateRollupConfig(finalArgs.name)];
    
  const webpackConfigs = generateWebpackConfig(finalArgs.name);
  
  const dependencies = {};
  
  // Track Rollup entries
  for (const config of rollupConfigs) {
    const entries = await getSourceFiles(config);
    for (const entry of entries) {
      try {
        const stat = await fs.stat(entry);
        dependencies[entry] = stat.mtimeMs;
      } catch (err) {
        console.log(chalk.yellow(`Could not stat file: ${entry}`));
      }
    }
  }
  
  // Track Webpack entries
  for (const config of webpackConfigs) {
    if (config.entry) {
      const entries = Array.isArray(config.entry) ? config.entry : [config.entry];
      for (const entry of entries) {
        try {
          const stat = await fs.stat(entry);
          dependencies[entry] = stat.mtimeMs;
        } catch (err) {
          console.log(chalk.yellow(`Could not stat file: ${entry}`));
        }
      }
    }
  }
  
  return dependencies;
}

function getEntryFromTaskTitle(title) {
  // This is a simplified implementation - in a real scenario, you'd map from
  // task titles back to original entry points
  return title;
}

async function hasChangedSince(dependencies, lastBuildTime) {
  for (const [file, mtime] of Object.entries(dependencies)) {
    if (mtime > lastBuildTime) {
      return true;
    }
  }
  return false;
}

// Error categorization function
function categorizeError(error, filename) {
  // Define patterns for different error categories
  const criticalPatterns = [
    /Cannot resolve entry module/i,
    /Bundle contains unresolved circular dependencies/i,
    /Invalid config format/i,
    /Permission denied/i
  ];
  
  const nonCriticalPatterns = [
    /Unused external imports/i,
    /Treeshaking not fully optimized/i,
    /Performance recommendation/i,
    /Deprecated feature/i
  ];
  
  // Check for critical errors first
  for (const pattern of criticalPatterns) {
    if (pattern.test(error.message)) {
      return { type: 'critical', message: error.message, filename };
    }
  }
  
  // Check for non-critical errors
  for (const pattern of nonCriticalPatterns) {
    if (pattern.test(error.message)) {
      return { type: 'non-critical', message: error.message, filename };
    }
  }
  
  // Default to unknown category
  return { type: 'unknown', message: error.message, filename };
}

function addOutput({ ctx, filename, formattedStats, type, warnings }) {
  if (!ctx.outputs) ctx.outputs = {};
  ctx.outputs[filename] = {
    type,
    formattedStats,
    warnings,
  };
}

function getRollupTasks() {
  const config = generateRollupConfig(finalArgs.name);
  const configOptions = Array.isArray(config) ? config : [config];

  return configOptions.map((configOption) => {
    // use dir option for dynamic imports
    const filenameChunks = configOption.output.dir ? configOption.output.dir.split("/") : configOption.output.file.split("/");
    const filename = filenameChunks[filenameChunks.length - 1];
    
    return {
      title: filename,
      task: async (ctx) => {
        // Check cache first
        const cacheKey = await getCacheKey(configOption, filename);
        const cachedResult = await checkCache(cacheKey);
        
        if (cachedResult) {
          console.log(chalk.green(`Using cached build for ${filename}`));
          const cachedOutput = JSON.parse(await fs.readFile(cachedResult, 'utf8'));
          
          // Copy cached files to build directory
          for (const file of cachedOutput.files) {
            const cacheSrcPath = path.join(CACHE_DIR, file.cacheFile);
            const outputFilePath = path.join(paths.appBuild, file.outputPath);
            
            // Ensure directories exist
            await fs.mkdir(path.dirname(outputFilePath), { recursive: true });
            
            try {
              await fs.copyFile(cacheSrcPath, outputFilePath);
            } catch (err) {
              console.log(chalk.yellow(`Could not copy cached file: ${err.message}`));
            }
          }
          
          addOutput({
            ctx,
            filename,
            formattedStats: cachedOutput.stats,
            warnings: [],
            type: "rollup"
          });
          
          return;
        }
        
        // Run the build using worker threads
        try {
          const result = await workerPool.runTask(async (data) => {
            const { rollup } = require('rollup');
            const configClone = JSON.parse(JSON.stringify(data.config));
            
            // Restore functions that were lost in serialization
            // This would need to be expanded for all possible plugins and options
            if (data.config.plugins) {
              configClone.plugins = data.config.plugins;
            }
            
            const start = process.hrtime.bigint();
            const bundle = await rollup(configClone);
            const generated = await bundle.generate(configClone.output);
            const output = await bundle.write(configClone.output);
            await bundle.close();
            const end = process.hrtime.bigint();
            const time = ((end - start) / BigInt(1e6)).toString();
            
            return { output, time };
          }, { config: configOption });
          
          const formattedStats = formatRollupStats(
            result.output.output, 
            filename, 
            paths.appBuild, 
            result.time
          );
          
          // Save to cache
          await saveToCache(cacheKey, {
            stats: formattedStats,
            files: result.output.output.map(o => ({
              cacheFile: `${cacheKey}-${path.basename(o.fileName)}`,
              outputPath: o.fileName
            }))
          });
          
          // Save a copy of each output file in the cache
          for (const output of result.output.output) {
            const cacheFilePath = path.join(CACHE_DIR, `${cacheKey}-${path.basename(output.fileName)}`);
            const outputFilePath = path.join(paths.appBuild, output.fileName);
            
            try {
              await fs.copyFile(outputFilePath, cacheFilePath);
            } catch (err) {
              console.log(chalk.yellow(`Could not cache file: ${err.message}`));
            }
          }
          
          addOutput({
            ctx, 
            filename, 
            formattedStats, 
            warnings: [], 
            type: "rollup"
          });
        } catch (error) {
          const categorizedError = categorizeError(error, filename);
          if (!ctx.errors) ctx.errors = {};
          ctx.errors[filename] = categorizedError;
                    if (categorizedError.type === 'critical') {
            console.log(chalk.red.bold(`CRITICAL ERROR in ${filename}: ${error.message}`));
            throw error; // Re-throw critical errors to stop the build process for this file
          } else {
            console.log(chalk.yellow(`NON-CRITICAL ERROR in ${filename}: ${error.message}`));
            // For non-critical errors, add partial output information so the build can continue
            addOutput({
              ctx,
              filename,
              formattedStats: [['Error', error.message, '', '']],
              warnings: [error.message],
              type: "rollup",
              hasError: true
            });
          }
        }
      },
    };
  });
}

function getWebpackTasks() {
  const configs = generateWebpackConfig(finalArgs.name);
  return configs.map((config) => {
    return {
      title: config.output.filename,
      task: async (ctx) => {
        // Generate cache key for webpack config
        const configStr = JSON.stringify(config, (key, value) => {
          // Exclude functions from stringification
          return typeof value === 'function' ? value.toString() : value;
        });
        
        const cacheKey = crypto
          .createHash('md5')
          .update(configStr)
          .update(config.output.filename)
          .digest('hex');
        
        const cachedResult = await checkCache(cacheKey);
        
        if (cachedResult) {
          console.log(chalk.green(`Using cached build for ${config.output.filename}`));
          const cachedOutput = JSON.parse(await fs.readFile(cachedResult, 'utf8'));
          
          // Copy cached files to build directory
          for (const file of cachedOutput.files) {
            const cacheSrcPath = path.join(CACHE_DIR, file.cacheFile);
            const outputFilePath = path.join(paths.appBuild, file.outputPath);
            
            // Ensure directories exist
            await fs.mkdir(path.dirname(outputFilePath), { recursive: true });
            
            try {
              await fs.copyFile(cacheSrcPath, outputFilePath);
            } catch (err) {
              console.log(chalk.yellow(`Could not copy cached file: ${err.message}`));
            }
          }
          
          addOutput({
            ctx,
            filename: config.output.filename,
            formattedStats: cachedOutput.stats,
            warnings: cachedOutput.warnings || [],
            type: "webpack"
          });
          
          return;
        }
        
        // No cache hit, proceed with webpack build
        return new Promise((resolve, reject) => {
          webpack(config, async (err, stats) => {
            try {
              let messages;
              if (err) {
                if (!err.message) {
                  const categorizedError = categorizeError(err, config.output.filename);
                  if (categorizedError.type === 'critical') {
                    return reject(err);
                  } else {
                    console.log(chalk.yellow(`NON-CRITICAL ERROR in ${config.output.filename}: ${err.message}`));
                    addOutput({
                      ctx,
                      filename: config.output.filename,
                      formattedStats: [['Error', err.message, '', '']],
                      warnings: [err.message],
                      type: "webpack",
                      hasError: true
                    });
                    return resolve();
                  }
                }

                messages = formatWebpackMessages({
                  errors: [err.message],
                  warnings: [],
                });
              } else {
                messages = formatWebpackMessages(stats.toJson({ all: false, warnings: true, errors: true }));
              }

              if (messages.errors.length) {
                // Check if any errors are critical
                let hasCriticalError = false;
                for (const error of messages.errors) {
                  const categorizedError = categorizeError(new Error(error), config.output.filename);
                  if (categorizedError.type === 'critical') {
                    hasCriticalError = true;
                    break;
                  }
                }
                
                if (hasCriticalError) {
                  // Only keep the first error to reduce noise
                  if (messages.errors.length > 1) {
                    messages.errors.length = 1;
                  }
                  return reject(new Error(messages.errors.join("\n\n")));
                } else {
                  // Handle non-critical errors
                  console.log(chalk.yellow(`NON-CRITICAL ERRORS in ${config.output.filename}`));
                  messages.errors.forEach(error => {
                    console.log(chalk.yellow(`- ${error}`));
                  });
                }
              }

              const formattedStats = formatWebpackStats(stats, paths.appBuild);
              
              // Save successful build to cache
              const outputFiles = stats.compilation.assets;
              const fileList = Object.keys(outputFiles).map(fileName => {
                const outputPath = path.join(config.output.path, fileName);
                const cachePath = `${cacheKey}-${fileName}`;
                
                // Copy the file to cache
                try {
                  fs.copyFile(outputPath, path.join(CACHE_DIR, cachePath));
                } catch (err) {
                  console.log(chalk.yellow(`Could not cache file: ${err.message}`));
                }
                
                return {
                  cacheFile: cachePath,
                  outputPath: fileName
                };
              });
              
              await saveToCache(cacheKey, {
                stats: formattedStats,
                warnings: messages.warnings,
                files: fileList
              });

              addOutput({ 
                ctx, 
                filename: config.output.filename, 
                warnings: messages.warnings, 
                formattedStats, 
                type: "webpack" 
              });

              return resolve();
            } catch (error) {
              return reject(error);
            }
          });
        });
      },
    };
  });
}

async function main() {
  console.log(chalk.blue('🛠️  Starting optimized build process...'));
  
  // Set up cache
  const cacheEnabled = await setupCache();
  if (cacheEnabled) {
    console.log(chalk.blue('✓ Build cache enabled'));
  }
  
  // Get last build information for incremental builds
  let lastBuildInfo = { time: 0, dependencies: {} };
  let isIncrementalBuild = false;
  
  try {
    const buildInfoExists = await fs.access(LAST_BUILD_FILE).then(() => true).catch(() => false);
    if (buildInfoExists) {
      lastBuildInfo = JSON.parse(await fs.readFile(LAST_BUILD_FILE, 'utf8'));
      isIncrementalBuild = true;
      console.log(chalk.blue('✓ Using incremental build approach'));
    }
  } catch (err) {
    console.log(chalk.yellow('Could not read previous build info, performing full build.'));
  }

  console.log(chalk.yellow("Cleaning dist folder..."));
  await deleteFolder(paths.appBuild);
  await fs.mkdir(paths.appBuild, { recursive: true });
  
  // Determine which files have changed for incremental builds
  let changedEntries = null;
  
  if (isIncrementalBuild) {
    const currentDependencies = await getEntryPointDependencies();
    changedEntries = {};
    
    for (const [entry, deps] of Object.entries(currentDependencies)) {
      if (await hasChangedSince(deps, lastBuildInfo.time)) {
        changedEntries[entry] = true;
      }
    }
    
    // If no entries have changed, we could potentially skip the build
    if (Object.keys(changedEntries).length === 0) {
      console.log(chalk.green('No files have changed since last build. Skipping.'));
      return;
    }
  }

  console.log(chalk.yellow("Collating builds..."));
  
  // Get all build tasks
  let rollupTasks = getRollupTasks();
  let webpackTasks = getWebpackTasks();
  
  // Filter tasks based on changed entries for incremental builds
  if (isIncrementalBuild && changedEntries) {
    rollupTasks = rollupTasks.filter(task => 
      changedEntries[getEntryFromTaskTitle(task.title)]
    );
    
    webpackTasks = webpackTasks.filter(task => 
      changedEntries[getEntryFromTaskTitle(task.title)]
    );
    
    console.log(chalk.blue(`Running builds for ${rollupTasks.length + webpackTasks.length} changed files`));
  }
  
  // Create a context to collect results
  let ctx = { outputs: {}, errors: {} };
  let criticalErrorOccurred = false;
  
  // Run tasks with improved error handling
  const runTasks = async (tasks) => {
    const results = [];
    
    console.log(chalk.blue(`Starting ${tasks.length} build tasks with ${WORKER_POOL_SIZE} workers`));
    
    // Run up to N tasks concurrently where N is the worker pool size
    const runningTasks = new Set();
    
    for (const task of tasks) {
      try {
        // Wait if we've reached max concurrency
        while (runningTasks.size >= WORKER_POOL_SIZE) {
          await Promise.race(runningTasks);
        }
        
        // Start new task
        const taskPromise = (async () => {
          try {
            console.log(chalk.blue(`Building: ${task.title}`));
            await task.task(ctx);
            results.push({ name: task.title, success: true });
          } catch (error) {
            const categorizedError = categorizeError(error, task.title);
            ctx.errors[task.title] = categorizedError;
            
            if (categorizedError.type === 'critical') {
              console.log(chalk.red.bold(`CRITICAL ERROR in ${task.title}: ${error.message}`));
              criticalErrorOccurred = true;
            } else {
              console.log(chalk.yellow(`NON-CRITICAL ERROR in ${task.title}: ${error.message}`));
            }
            
            results.push({ name: task.title, success: false, error });
          }
        })();
        
        runningTasks.add(taskPromise);
        
        // Clean up finished task
        taskPromise.then(() => {
          runningTasks.delete(taskPromise);
        });
      } catch (error) {
        console.error(chalk.red(`Task setup error for ${task.title}: ${error.message}`));
        results.push({ name: task.title, success: false, error });
      }
    }
    
    // Wait for all remaining tasks to complete
    while (runningTasks.size > 0) {
      await Promise.race(runningTasks);
    }
    
    return results;
  };
  
  try {
    // Run all tasks
    const rollupResults = rollupTasks.length > 0 ? await runTasks(rollupTasks) : [];
    const webpackResults = webpackTasks.length > 0 ? await runTasks(webpackTasks) : [];
    const allResults = [...rollupResults, ...webpackResults];
    
    // Save build info for next incremental build
    await fs.writeFile(LAST_BUILD_FILE, JSON.stringify({
      time: Date.now(),
      dependencies: await getEntryPointDependencies()
    }));

    // Print warnings for each build
    Object.keys(ctx.outputs).forEach((filename) => {
      const outputObj = ctx.outputs[filename];
      const warnings = outputObj.warnings;
      if (warnings && warnings.length > 0) {
        console.log(chalk.yellow(`\nCompiled ${filename} with warnings.\n`));
        console.log(warnings.join("\n\n"));
        console.log("\nSearch for the " + chalk.underline(chalk.yellow("keywords")) + " to learn more about each warning.");
        console.log("To ignore, add " + chalk.cyan("// eslint-disable-next-line") + " to the line before.\n");
      }
    });

    // Display build summary
    console.log(chalk.bold('\nBuild Summary:'));
    const successCount = allResults.filter(r => r.success).length;
    const failureCount = allResults.length - successCount;
    
    console.log(chalk.green(`✓ Successfully built: ${successCount} files`));
    if (failureCount > 0) {
      console.log(chalk.yellow(`✗ Failed to build: ${failureCount} files`));
    }
    
    // Format the output table with statistics
    ui.div(chalk.cyan.bold(`File`), chalk.cyan.bold(`Size`), chalk.cyan.bold(`Gzipped`), chalk.cyan.bold(`Time`));

    Object.keys(ctx.outputs).forEach((filename) => {
      const outputObj = ctx.outputs[filename];
      if (!outputObj.hasError) {
        outputObj.formattedStats.map((x) => ui.div(...x));
      } else {
        ui.div(
          chalk.red(filename),
          chalk.red("Error"),
          chalk.red("N/A"),
          chalk.red("N/A")
        );
      }
    });

    ui.div(`\n ${chalk.gray(`Images and other types of assets omitted.`)}\n`);

    console.log(ui.toString());

    // Final build status
    if (criticalErrorOccurred) {
      console.log(chalk.yellow("⚠️  Build completed with critical errors"));
      process.exit(1);
    } else if (failureCount > 0) {
      console.log(chalk.green("✅ Build completed with non-critical errors"));
    } else {

      console.log(chalk.green("✅ Build completed successfully"));
    }
    
    // Display performance metrics
    if (cacheEnabled) {
      const cacheHits = Object.values(ctx.outputs).filter(o => o.fromCache).length;
      if (cacheHits > 0) {
        console.log(chalk.green(`🚀 Performance: ${cacheHits} files loaded from cache`));
      }
    }
    
  } catch (error) {
    console.error(chalk.red("Build process encountered an error:"));
    console.error(chalk.red(error.message));
    console.error(chalk.red(error.stack));
    process.exit(1);
  }
}

updatePackageNotification();

if (finalArgs.help) {
  console.log(buildHelpText);
  process.exit(0);
}

main();
