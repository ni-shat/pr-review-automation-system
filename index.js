const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();
const app = express();
const Groq = require('groq-sdk');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

app.use(cors());
app.use(express.json());

const port = 4000;

const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID;
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET;
const GITHUB_REDIRECT_URI = process.env.GITHUB_REDIRECT_URI;


const { MongoClient, ServerApiVersion } = require('mongodb');
const uri = process.env.MONGODB_URI;

const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});


async function run() {
    try {
        
        const userCollection = client.db("prReviewSystemDb").collection("users");

        // OAuth Authorization Route
        app.get('/auth/github', (req, res) => {
            const githubAuthURL = `https://github.com/login/oauth/authorize?client_id=${GITHUB_CLIENT_ID}&redirect_uri=${GITHUB_REDIRECT_URI}&scope=repo`;
            res.redirect(githubAuthURL);
        });


        // Callback route for GitHub OAuth
        app.get('/auth/github/callback', async (req, res) => {
            const code = req.query.code;
            if (!code) {
                return res.status(400).send('No code provided');
            }

            try {
                // Exchange the code for an access token
                const tokenResponse = await axios.post(
                    `https://github.com/login/oauth/access_token`,
                    {
                        client_id: GITHUB_CLIENT_ID,
                        client_secret: GITHUB_CLIENT_SECRET,
                        code: code,
                    },
                    {
                        headers: { Accept: 'application/json' },
                    }
                );

                const accessToken = tokenResponse.data.access_token;

                // Call the function to get the user's repositories
                const repositories = await getUserRepositories(accessToken);
                if (repositories.length === 0) {
                    console.log('No repositories found for the user')
                    return res.status(400).send('No repositories found for the user');
                }

                // Get repoOwner and repoName from the first repository
                const repoOwner = repositories[0].owner.login; // Repository owner
                // const repoName = repositories[0].name;         // Repository name
                console.log('repo owner : ', repoOwner,);



                // **Store the access token**  // res.json({ accessToken }); come here
                try {
                    await userCollection.insertOne({ accessToken, repoOwner });
                    // console.log('Access token stored in MongoDB');
                    // res.status(200).send('Review posted and comment added');
                    res.redirect('http://localhost:5173/dashboard');

                } catch (error) {
                    console.error('Error storing access token:', error);
                    res.status(500).json({ error: 'Failed to store access token' });
                }
                // **Store the access token - END **



                // **Call the function to create the webhook after getting the access token and repo details**
                // await createWebhook(accessToken, repoOwner, repoName);

                for (const repository of repositories) {
                    const repoName = repository.name; // Repository name
                    console.log('Creating webhook for repository: ', repoName);
                    try {
                        await createWebhook(accessToken, repoOwner, repoName);
                    } catch (error) {
                        console.error(`Error creating webhook for ${repoName}:`, error);
                    }
                }



            } catch (error) {
                console.error('Error exchanging code for token:', error);
                res.status(500).send('Error during authentication');
            }
        });


        // Function to get user's repositories
        async function getUserRepositories(accessToken) {
            try {
                const response = await axios.get('https://api.github.com/user/repos', {
                    headers: {
                        Authorization: `Bearer ${accessToken}`, // Use the OAuth token
                    },
                });

                return response.data; // Returns an array of repository details
            } catch (error) {
                console.error('Error fetching user repositories:', error.response ? error.response.data : error.message);
                return [];
            }
        }


        // Webhook creation function
        async function createWebhook(accessToken, repoOwner, repoName) {
            try {
                // Webhook configuration
                const webhookData = {
                    name: 'web',
                    active: true,
                    events: ['pull_request'], // Listen for PR events
                    config: {
                        url: 'https://5899-27-147-186-32.ngrok-free.app/webhook', // The endpoint on your server that GitHub will call
                        content_type: 'json',
                        insecure_ssl: '0',
                    }
                };

                // Send POST request to create the webhook
                await axios.post(
                    `https://api.github.com/repos/${repoOwner}/${repoName}/hooks`,
                    webhookData,
                    {
                        headers: {
                            Authorization: `Bearer ${accessToken}`,
                            Accept: 'application/vnd.github.v3+json',
                        }
                    }
                );

                console.log('Webhook created successfully');
                // console.log('Webhook created successfully:', response?.data);

            } catch (error) {
                console.error('Error creating webhook:', error.response ? error.response.data : error);
            }
        }



        // Webhook endpoint to receive PR events
        app.post('/webhook', async (req, res) => {
            // Log the received payload for debugging purposes
            // console.log('I am in webhook');
            // console.log('Received webhook:', JSON.stringify(req.body, null, 2)); //understand what it means null 2

            // Check if the event is a pull request event
            const pullRequest = req.body.action === 'opened' || req.body.action === 'edited';

            if (pullRequest) {
                console.log('Pull request detected')

                const prDetails = req.body.pull_request; // Get pull request details
                const prTitle = prDetails.title; // PR title
                const prBody = prDetails.body; // PR description
                const prChanges = prDetails.diff_url; // URL of the diff/changes
                const repoOwner = prDetails.user.login; //user name of the user

                console.log(`Reviewing PR #${prDetails.number}: ${prTitle}`);

                // Simulate AI review (replace this with real AI logic)
                const reviewComment = await generateAIReview(prTitle, prBody, prChanges);


                // For step 5
                try {
                    console.log('in try catch after pr detected')
                    // Find the access token from db by repoOwner
                    const tokenDoc = await userCollection.findOne({ repoOwner: repoOwner });
                    if (tokenDoc) {
                        // console.log('i am in tokenDoc')
                        // Return the repo owner from the document
                        const accessToken = tokenDoc.accessToken; //come
                        console.log('')
                        console.log('')
                        console.log('AccessToken: ' , tokenDoc.accessToken)

                        // **Step 5: Post the review as a comment on the PR**
                        const repoFullName = req.body.repository.full_name; // e.g., "user/repo"
                        const prNumber = prDetails.number; // The PR number

                        // Construct the URL to post a comment on the PR
                        const commentUrl = `https://api.github.com/repos/${repoFullName}/issues/${prNumber}/comments`;

                        // Send a request to GitHub to post the comment
                        await axios.post(commentUrl, {
                            body: reviewComment, // The comment to post
                        }, {
                            headers: {
                                'Authorization': `Bearer ${accessToken}`, // Use your GitHub token
                                'Accept': 'application/vnd.github.v3+json',
                                'Content-Type': 'application/json'
                            }
                        });
                        // ** End step 5**
                        console.log('Review posted and comment added')
                        // res.status(200).send('Review posted and comment added');

                    } else {
                        console.log('No document found with the provided access token');
                        return null; // or throw an error
                    } // End if token

                    // console.log(`Comment posted on PR #${prNumber}`);
                    // console.log(`Review posted for PR #${prDetails.number}`);
                    res.status(200).send('Review posted and comment added');

                } catch (error) {
                    // console.error('Error posting review:', error);
                    console.error('Error posting review:', error);
                    res.status(500).send('Error posting review');
                } // End step 5


            } // END if pullrequest  

            // else - Not a pull request event
            else {
                // console.log('No relevant PR action detected');
                // res.status(200).send('No PR action detected');
            }
        });


        // Function to generate AI review using GPT
        async function generateAIReview(prTitle, prBody, prChanges) {
            const prompt = `You are an AI that reviews pull requests. Analyze the following pull request and provide feedback on the code quality, potential improvements, or any concerns.
    
            PR Title: ${prTitle}
            PR Description: ${prBody}
            Changes: ${prChanges}
            
            Review:`;

            try {
                const chatCompletion = await getGroqChatCompletion(prompt);
                // Print the completion returned by the LLM.
                console.log("")
                console.log("")
                console.log(chatCompletion.choices[0]?.message?.content || "No review generated.");
                return chatCompletion.choices[0]?.message?.content;
            } catch (error) {
                console.error("Failed to generate AI review:", error);
            }
        }


        // Updated getGroqChatCompletion function to accept a custom prompt
        async function getGroqChatCompletion(prompt) {
            return groq.chat.completions.create({
                messages: [
                    {
                        role: "user",
                        content: prompt,
                    },
                ],
                model: "llama3-8b-8192", // Assuming this is your chosen model
            });
        }

    

        // Send a ping to confirm a successful connection
        await client.db("admin").command({ ping: 1 });
        console.log("Pinged your deployment. You successfully connected to MongoDB!");
    } finally {
        // Ensures that the client will close when you finish/error
        // await client.close();
    }
}
run().catch(console.dir);



app.get('/', (req, res) => {
    res.send(' server is running')
})

app.listen(port, () => {
    console.log(` server is running on ${port}`);
})







