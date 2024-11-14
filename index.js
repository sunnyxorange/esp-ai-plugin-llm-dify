module.exports = {
    // 插件名称
    name: "esp-ai-plugin-llm-dify",
    // 插件类型
    type: "LLM",
    // 主要逻辑
    main({ devLog, device_id, llm_config, text, llmServerErrorCb, llm_init_messages = [], llm_historys = [], cb, logWSServer, connectServerBeforeCb, connectServerCb, log }) {
        try {
            // 获取配置
            const { apiKey, baseURL = 'https://api.dify.ai/v1' } = llm_config;
            if (!apiKey) return log.error(`请配置 Dify API Key`);

            // 标记连接开始
            connectServerBeforeCb();

            // 准备消息历史
            const messages = [
                ...llm_init_messages,
                ...llm_historys,
                {
                    "role": "user", 
                    "content": text
                }
            ];

            // 准备请求参数
            const requestData = {
                query: text,
                user: device_id, // 使用device_id作为用户标识
                response_mode: "streaming", // 使用流式响应
                conversation_id: "", // 新会话
                inputs: {}
            };

            // 发起请求
            fetch(`${baseURL}/chat-messages`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(requestData)
            }).then(response => {
                if (!response.ok) {
                    throw new Error(`HTTP error! status: ${response.status}`);
                }
                
                // 标记连接成功
                connectServerCb(true);

                // 处理SSE流
                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                const texts = {
                    all_text: "",
                    count_text: "",
                    index: 0
                };

                // 提供关闭方法
                logWSServer({
                    close: () => {
                        connectServerCb(false);
                        reader.cancel();
                    }
                });

                // 读取流
                function readStream() {
                    reader.read().then(({done, value}) => {
                        if (done) {
                            connectServerCb(false);
                            return;
                        }

                        const chunk = decoder.decode(value);
                        const lines = chunk.split('\n');
                        
                        lines.forEach(line => {
                            if (line.startsWith('data: ')) {
                                try {
                                    const data = JSON.parse(line.slice(6));
                                    
                                    if (data.event === 'message') {
                                        // 处理文本块
                                        texts.count_text += data.answer;
                                        cb({ 
                                            text,
                                            texts,
                                            chunk_text: data.answer
                                        });
                                    } else if (data.event === 'message_end') {
                                        // 处理结束事件
                                        cb({
                                            text,
                                            is_over: true,
                                            texts,
                                            metadata: data.metadata
                                        });
                                    } else if (data.event === 'error') {
                                        // 处理错误
                                        llmServerErrorCb(data.message);
                                        connectServerCb(false);
                                    }
                                } catch (e) {
                                    devLog && log.error('Parse chunk error:', e);
                                }
                            }
                        });

                        readStream();
                    }).catch(error => {
                        llmServerErrorCb(error.message);
                        connectServerCb(false);
                    });
                }

                readStream();

            }).catch(error => {
                llmServerErrorCb(error.message);
                connectServerCb(false);
            });

        } catch (err) {
            log.error("Dify LLM 插件错误:", err);
            connectServerCb(false);
        }
    }
}; 
