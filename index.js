module.exports = {
    name: "esp-ai-plugin-llm-dify",
    type: "LLM",
    async main({ devLog, device_id, llm_config, text, llmServerErrorCb, llm_init_messages = [], llm_historys = [], cb, logWSServer, connectServerBeforeCb, connectServerCb, log }) {
        try {
            // 1. 配置参数处理
            const { 
                api_key, 
                api_url = 'http://120.26.237.25/v1',
                timeout = 60000,  // 超时时间，默认60秒
                max_retries = 3   // 最大重试次数
            } = llm_config;

            if (!api_key) {
                log.error("请配置 Dify API Key");
                return;
            }

            // 2. 状态控制
            let shouldClose = false;
            let retryCount = 0;

            // 3. 文本对象结构
            const texts = {
                all_text: "",
                count_text: "",
                index: 0
            };

            // 4. 错误处理函数
            const handleError = (status) => {
                const errorMessages = {
                    400: "参数错误或应用不可用",
                    404: "对话不存在",
                    413: "文件太大",
                    415: "不支持的文件类型",
                    500: "服务器内部错误",
                    503: "服务暂时不可用"
                };
                return errorMessages[status] || `未知错误 (${status})`;
            };

            // 5. 主要请求函数
            async function streamCompletion() {
                try {
                    connectServerBeforeCb();

                    // 准备请求数据
                    const requestData = {
                        query: text,
                        user: device_id,
                        response_mode: "streaming",
                        conversation_id: "",
                        inputs: {},
                        messages: [
                            ...llm_init_messages,
                            ...llm_historys,
                            { role: "user", content: text }
                        ]
                    };

                    // 创建 AbortController 用于超时控制
                    const controller = new AbortController();
                    const timeoutId = setTimeout(() => controller.abort(), timeout);

                    // 发送请求
                    const response = await fetch(`${api_url}/chat-messages`, {
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${api_key}`,
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify(requestData),
                        signal: controller.signal
                    });

                    clearTimeout(timeoutId);

                    if (!response.ok) {
                        throw new Error(handleError(response.status));
                    }

                    connectServerCb(true);

                    // 注册关闭处理器
                    logWSServer({
                        close: () => {
                            connectServerCb(false);
                            shouldClose = true;
                            controller.abort();
                        }
                    });

                    // 处理流式响应
                    const reader = response.body.getReader();
                    const decoder = new TextDecoder();

                    while (true) {
                        if (shouldClose) break;

                        const { done, value } = await reader.read();
                        if (done) break;

                        const chunk = decoder.decode(value);
                        const lines = chunk.split('\n\n').filter(line => line.trim());

                        for (const line of lines) {
                            if (line.startsWith('data: ')) {
                                try {
                                    const data = JSON.parse(line.slice(6));
                                    
                                    switch (data.event) {
                                        case 'message':
                                            if (data.answer) {
                                                texts.count_text += data.answer;
                                                devLog === 2 && log.llm_info('LLM 输出：', data.answer);
                                                cb({ text, texts, chunk_text: data.answer });
                                            }
                                            break;

                                        case 'message_end':
                                            if (!shouldClose) {
                                                cb({
                                                    text,
                                                    is_over: true,
                                                    texts,
                                                    metadata: data.metadata
                                                });
                                            }
                                            break;

                                        case 'error':
                                            throw new Error(data.message);

                                        case 'message_file':
                                            // 处理文件类型消息
                                            if (data.type === 'image') {
                                                cb({
                                                    text,
                                                    texts,
                                                    file: {
                                                        type: 'image',
                                                        url: data.url
                                                    }
                                                });
                                            }
                                            break;
                                    }
                                } catch (error) {
                                    devLog && log.error('Parse chunk error:', error);
                                }
                            }
                        }
                    }

                    connectServerCb(false);
                    devLog && log.llm_info('===');
                    devLog && log.llm_info(texts.count_text);
                    devLog && log.llm_info('===');
                    devLog && log.llm_info('LLM connect close!\n');

                } catch (error) {
                    if (error.name === 'AbortError') {
                        llmServerErrorCb("请求超时");
                    } else if (retryCount < max_retries) {
                        retryCount++;
                        devLog && log.llm_info(`重试第 ${retryCount} 次`);
                        await new Promise(resolve => setTimeout(resolve, 1000 * retryCount));
                        return streamCompletion();
                    } else {
                        llmServerErrorCb(`Dify LLM 错误: ${error.message}`);
                    }
                    connectServerCb(false);
                }
            }

            // 6. 启动请求
            await streamCompletion();

        } catch (err) {
            log.error("Dify LLM 插件错误：", err);
            connectServerCb(false);
        }
    }
};
