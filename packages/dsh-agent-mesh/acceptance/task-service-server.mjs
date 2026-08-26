import { writeFile } from 'node:fs/promises'
import { InMemoryTaskStore, TaskHttpServer, TaskService } from '../lib/tasks/index.js'
const service=new TaskService(new InMemoryTaskStore(),{async execute(task,context){await context.log({worker:process.pid});return task.input ?? null}})
const server=new TaskHttpServer(service,{serviceName:'task-smoke'});const address=await server.start();await writeFile(process.env.ADDRESS_FILE,JSON.stringify(address));
const stop=async()=>{await server.stop();process.exit(0)};process.once('SIGTERM',stop);process.once('SIGINT',stop)
