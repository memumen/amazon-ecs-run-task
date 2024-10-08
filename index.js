const path = require('path');
const core = require('@actions/core');
const { ECS, waitUntilTasksStopped } = require('@aws-sdk/client-ecs');
const yaml = require('yaml');
const fs = require('fs');

// Attributes that are returned by DescribeTaskDefinition, but are not valid RegisterTaskDefinition inputs
const IGNORED_TASK_DEFINITION_ATTRIBUTES = [
  'compatibilities',
  'taskDefinitionArn',
  'requiresAttributes',
  'revision',
  'status',
  'registeredAt',
  'registeredBy'
];

const WAIT_DEFAULT_DELAY_SEC = 5;
const MAX_WAIT_MINUTES = 360;

function isEmptyValue(value) {
  if (value === null || value === undefined || value === '') {
    return true;
  }

  if (Array.isArray(value)) {
    for (var element of value) {
      if (!isEmptyValue(element)) {
        // the array has at least one non-empty element
        return false;
      }
    }
    // the array has no non-empty elements
    return true;
  }

  if (typeof value === 'object') {
    for (var childValue of Object.values(value)) {
      if (!isEmptyValue(childValue)) {
        // the object has at least one non-empty property
        return false;
      }
    }
    // the object has no non-empty property
    return true;
  }

  return false;
}

function emptyValueReplacer(_, value) {
  if (isEmptyValue(value)) {
    return undefined;
  }

  if (Array.isArray(value)) {
    return value.filter(e => !isEmptyValue(e));
  }

  return value;
}

function cleanNullKeys(obj) {
  return JSON.parse(JSON.stringify(obj, emptyValueReplacer));
}

function removeIgnoredAttributes(taskDef) {
  for (var attribute of IGNORED_TASK_DEFINITION_ATTRIBUTES) {
    if (taskDef[attribute]) {
      // core.warning(`Ignoring property '${attribute}' in the task definition file. ` +
      //   'This property is returned by the Amazon ECS DescribeTaskDefinition API and may be shown in the ECS console, ' +
      //   'but it is not a valid field when registering a new task definition. ' +
      //   'This field can be safely removed from your task definition file.');
      delete taskDef[attribute];
    }
  }

  return taskDef;
}

async function run() {
  try {
    const agent = 'amazon-ecs-run-task-for-github-actions'

    const ecs = new ECS({
      customUserAgent: agent
    });

    // Get inputs
    const taskDefinitionFile = core.getInput('task-definition', { required: true });
    const cluster = core.getInput('cluster', { required: false });
    const count = core.getInput('count', { required: true });
    const startedBy = core.getInput('started-by', { required: false }) || agent;
    const waitForFinish = core.getInput('wait-for-finish', { required: false }) || false;
    let waitForMinutes = parseInt(core.getInput('wait-for-minutes', { required: false })) || 30;
    if (waitForMinutes > MAX_WAIT_MINUTES) {
      waitForMinutes = MAX_WAIT_MINUTES;
    }
    const subnets = core.getInput("subnets", { required: true });
    const securityGroups = core.getInput("security-groups", { required: true });

    // Register the task definition
    core.debug('Registering the task definition');
    const taskDefPath = path.isAbsolute(taskDefinitionFile) ?
      taskDefinitionFile :
      path.join(process.env.GITHUB_WORKSPACE, taskDefinitionFile);
    const fileContents = fs.readFileSync(taskDefPath, 'utf8');
    const taskDefContents = removeIgnoredAttributes(cleanNullKeys(yaml.parse(fileContents)));

    let registerResponse;
    try {
      registerResponse = await ecs.registerTaskDefinition(taskDefContents);
    } catch (error) {
      core.setFailed("Failed to register task definition in ECS: " + error.message);
      core.debug("Task definition contents:");
      core.debug(JSON.stringify(taskDefContents, undefined, 4));
      throw(error);
    }
    const taskDefArn = registerResponse.taskDefinition.taskDefinitionArn;
    core.setOutput('task-definition-arn', taskDefArn);

    const clusterName = cluster ? cluster : 'default';

    core.debug(`Running task with ${JSON.stringify({
      cluster: clusterName,
      taskDefinition: taskDefArn,
      count: count,
      startedBy: startedBy
    })}`)

    const runTaskResponse = await ecs.runTask({
      cluster: clusterName,
      taskDefinition: taskDefArn,
      count: parseInt(count),
      startedBy: startedBy,
      launchType: 'FARGATE',
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: subnets.split("|"),
          securityGroups: securityGroups.split("|"),
        },
      },
    });

    core.debug(`Run task response ${JSON.stringify(runTaskResponse)}`)

    const taskArns = runTaskResponse.tasks.map(task => task.taskArn);
    core.setOutput('run-task-arn', taskArns);

    const region = await ecs.config.region();
    const consoleHostname = region.startsWith('cn') ? 'console.amazonaws.cn' : 'console.aws.amazon.com';

    core.info(`Task running: https://${consoleHostname}/ecs/home?region=${region}#/clusters/${clusterName}/tasks`);

    if (runTaskResponse.failures && runTaskResponse.failures.length > 0) {
      const failure = runTaskResponse.failures[0];
      throw new Error(`${failure.arn} is ${failure.reason}`);
    }

    // Wait for task to end
    if (waitForFinish && waitForFinish.toLowerCase() === "true") {
      await waitForTasksStopped(ecs, clusterName, taskArns, waitForMinutes);
      await tasksExitCode(ecs, clusterName, taskArns);
    } else {
      core.debug('Not waiting for the task to stop');
    }
  }
  catch (error) {
    core.setFailed(error.message);
    core.debug(error.stack);
  }
}

async function waitForTasksStopped(ecs, clusterName, taskArns, waitForMinutes) {
  if (waitForMinutes > MAX_WAIT_MINUTES) {
    waitForMinutes = MAX_WAIT_MINUTES;
  }

  const maxAttempts = (waitForMinutes * 60) / WAIT_DEFAULT_DELAY_SEC;

  core.debug('Waiting for tasks to stop');

  const waitTaskResponse = await waitUntilTasksStopped({
    client: ecs,
    minDelay: WAIT_DEFAULT_DELAY_SEC,
    maxWaitTime: waitForMinutes * 60,
    maxAttempts: maxAttempts
  }, {
    cluster: clusterName,
    tasks: taskArns,
  });

  core.debug(`Run task response ${JSON.stringify(waitTaskResponse)}`);
  core.info('All tasks have stopped.');
}

async function tasksExitCode(ecs, clusterName, taskArns) {
  const describeResponse = await ecs.describeTasks({
    cluster: clusterName,
    tasks: taskArns
  });

  const containers = [].concat(...describeResponse.tasks.map(task => task.containers))
  const exitCodes = containers.map(container => container.exitCode)
  const reasons = containers.map(container => container.reason)

  const failuresIdx = [];

  core.debug(`containers ${JSON.stringify(containers)}`);
  core.debug(`exitCodes ${JSON.stringify(exitCodes)}`);
  core.debug(`reasons ${JSON.stringify(reasons)}`);

  exitCodes.filter((exitCode, index) => {
    core.debug(`exitCode ${JSON.stringify(exitCode)}`);
    if (exitCode !== 0) {
      failuresIdx.push(index)
    }
  })

  const failures = reasons.filter((_, index) => failuresIdx.indexOf(index) !== -1);

  core.debug(`failures ${JSON.stringify(failures)}`);

  if (failures.length > 0) {
    throw new Error(`Run task failed: ${JSON.stringify(failures)}`);
  }
}

module.exports = run;

/* istanbul ignore next */
if (require.main === module) {
    run();
}
